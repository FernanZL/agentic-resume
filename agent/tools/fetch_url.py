"""URL fetching and prompt-injection sanitization for untrusted web and user content."""

import asyncio
import html
import ipaddress
import re
import socket
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
import trafilatura
from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel

MAX_BYTES = 2 * 1024 * 1024
MAX_REDIRECTS = 5

_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_AUTH_WALL_HOSTS = frozenset({"linkedin.com", "www.linkedin.com"})
_AUTH_WALL_PATTERNS = re.compile(
    r"(authwall|sign\s+in\s+to\s+view|join\s+linkedin|login\s+to\s+continue)",
    re.IGNORECASE,
)
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_TEXT_MIME_TYPES = frozenset({"application/xhtml+xml", "application/xml"})

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)

_INJECTION_PATTERNS = [
    re.compile(
        r"\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?"
        r"(previous|prior|above|earlier|system)\s+"
        r"(instructions?|prompts?|rules?|directions?|directives?)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b(system\s+prompt|new\s+instructions?|you\s+are\s+now\s+a)\b", re.IGNORECASE),
    re.compile(
        r"(<\|\s*(system|user|assistant|im_start|im_end)\s*\|>|\[/?INST\]|</?system>)",
        re.IGNORECASE,
    ),
    re.compile(r"</?untrusted_content[^>]*>", re.IGNORECASE),
]


class FetchResult(BaseModel):
    """Structured result of fetching and extracting plain text from a URL."""

    url: str
    ok: bool
    title: str = ""
    text: str = ""
    error: str = ""


class _PinnedTarget(BaseModel):
    """Validated request target with IP-pinned URL, Host header, and SNI hostname."""

    original_url: str
    pinned_url: str
    host_header: str
    sni_hostname: str


def _is_forbidden_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return True if an IPv4 or IPv6 address (including IPv4-mapped) is non-public."""
    if (
        isinstance(ip, ipaddress.IPv6Address)
        and ip.ipv4_mapped is not None
        and _is_forbidden_ip(ip.ipv4_mapped)
    ):
        return True
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _resolve_host_ips(hostname: str) -> list[str]:
    """Resolve hostname via socket.getaddrinfo in a synchronous helper."""
    infos = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    return [str(sockaddr[0]) for *_, sockaddr in infos if sockaddr]


def _is_auth_wall_url(url: str) -> bool:
    """Return True if the URL points to a known authentication-walled host or path."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host in _AUTH_WALL_HOSTS or host.endswith(".linkedin.com"):
        return True
    path_lower = parts.path.lower()
    return "/authwall" in path_lower or "/login" in path_lower


async def _validate_resolved_host(host: str) -> tuple[str | None, str | None]:
    """Validate an IP literal or resolve a hostname and return (validated_ip, error)."""
    try:
        literal_ip = ipaddress.ip_address(host.split("%")[0])
    except ValueError:
        literal_ip = None

    if literal_ip is not None:
        if _is_forbidden_ip(literal_ip):
            return None, "Refusing to fetch private, loopback, or internal network addresses."
        return str(literal_ip), None

    try:
        resolved = await asyncio.to_thread(_resolve_host_ips, host)
    except OSError as exc:
        return None, f"Could not resolve hostname '{host}': {exc}"

    if not resolved:
        return None, f"Could not resolve hostname '{host}'."

    validated_ips: list[str] = []
    for raw_ip in resolved:
        try:
            ip = ipaddress.ip_address(raw_ip.split("%")[0])
        except ValueError:
            return None, f"Invalid IP address resolved for '{host}'."
        if _is_forbidden_ip(ip):
            return None, "Refusing to fetch host resolving to a private, loopback, or reserved IP."
        validated_ips.append(str(ip))

    return validated_ips[0], None


def _format_host_port(host: str, port: int | None) -> str:
    """Format a hostname or IP (with brackets for IPv6) and optional port."""
    bracketed = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"{bracketed}:{port}" if port is not None else bracketed


async def _resolve_pinned_target(url: str) -> tuple[_PinnedTarget | None, str | None]:
    """Validate URL scheme/host/IPs and return a DNS-pinned target or an error message."""
    cleaned_url = url.strip()
    parts = urlsplit(cleaned_url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None, "Only http and https URLs with a valid hostname are allowed."
    if _is_auth_wall_url(cleaned_url):
        return (
            None,
            "This site is behind an authentication wall; please paste the posting text directly.",
        )

    try:
        port = parts.port
    except ValueError:
        return None, "Invalid port in URL."

    host = parts.hostname.strip("[]").lower()
    if not host or host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return None, "Refusing to fetch private, loopback, or internal network addresses."

    validated_ip, safety_error = await _validate_resolved_host(host)
    if safety_error or not validated_ip:
        return None, safety_error or f"Could not validate host '{host}'."

    pinned_netloc = _format_host_port(validated_ip, port)
    pinned_url = urlunsplit((parts.scheme, pinned_netloc, parts.path, parts.query, parts.fragment))
    host_header = _format_host_port(host, port)

    return (
        _PinnedTarget(
            original_url=cleaned_url,
            pinned_url=pinned_url,
            host_header=host_header,
            sni_hostname=host,
        ),
        None,
    )


def _is_supported_content_type(content_type_header: str) -> bool:
    """Return True if the response Content-Type is empty or a readable text/HTML format."""
    mime = content_type_header.split(";")[0].strip().lower()
    if not mime:
        return True
    return mime.startswith("text/") or mime in _TEXT_MIME_TYPES


async def _read_bounded_text(resp: httpx.Response, max_bytes: int | None = None) -> str:
    """Read up to max_bytes of decompressed response content and decode to text."""
    limit = MAX_BYTES if max_bytes is None else max_bytes
    chunks: list[bytes] = []
    total = 0
    async for chunk in resp.aiter_bytes():
        remaining = limit - total
        if remaining <= 0:
            break
        if len(chunk) > remaining:
            chunks.append(chunk[:remaining])
            break
        chunks.append(chunk)
        total += len(chunk)
    encoding = resp.encoding or "utf-8"
    return b"".join(chunks).decode(encoding, errors="replace")


def _extract_title_and_text(raw_html: str) -> tuple[str, str]:
    """Extract document title and readable body text from HTML."""
    title_match = _TITLE_RE.search(raw_html)
    title = html.unescape(title_match.group(1)).strip() if title_match else ""
    extracted = trafilatura.extract(raw_html, include_comments=False, include_tables=True)
    if not extracted:
        cleaned = _SCRIPT_STYLE_RE.sub(" ", raw_html)
        extracted = html.unescape(_TAG_RE.sub(" ", cleaned))
    text = re.sub(r"\s+", " ", extracted).strip() if extracted else ""
    return title, text


def _evaluate_response_text(url: str, final_url: str, raw_html: str, max_chars: int) -> FetchResult:
    """Parse HTML into title and text, rejecting empty or login-walled bodies."""
    title, text = _extract_title_and_text(raw_html)
    if not text or (len(text) < 240 and _AUTH_WALL_PATTERNS.search(text)):
        return FetchResult(
            url=url,
            ok=False,
            title=title,
            error="Could not extract readable job text; please paste the posting text directly.",
        )
    return FetchResult(url=final_url, ok=True, title=title, text=text[:max_chars])


async def _stream_once(
    origin_url: str, target: _PinnedTarget, client: httpx.AsyncClient, max_chars: int
) -> tuple[str | None, FetchResult | None]:
    """Stream one GET request pinned to the validated IP; return redirect URL or FetchResult."""
    try:
        async with client.stream(
            "GET",
            target.pinned_url,
            timeout=15.0,
            follow_redirects=False,
            headers={"User-Agent": _USER_AGENT, "Host": target.host_header},
            extensions={"sni_hostname": target.sni_hostname},
        ) as resp:
            if resp.status_code in _REDIRECT_STATUSES:
                location = resp.headers.get("location", "").strip()
                if not location:
                    return None, FetchResult(
                        url=origin_url, ok=False, error="Redirect response missing Location header."
                    )
                return urljoin(target.original_url, location), None

            if resp.status_code in (401, 403, 999):
                msg = "Page requires sign-in (auth wall); please paste the posting text directly."
                return None, FetchResult(url=origin_url, ok=False, error=msg)
            if resp.status_code >= 400:
                return None, FetchResult(
                    url=origin_url, ok=False, error=f"HTTP {resp.status_code} when fetching URL."
                )

            content_type = resp.headers.get("content-type", "")
            if not _is_supported_content_type(content_type):
                return None, FetchResult(
                    url=origin_url,
                    ok=False,
                    error=f"Unsupported non-text content type: {content_type}",
                )

            raw_html = await _read_bounded_text(resp, MAX_BYTES)
    except httpx.HTTPError as exc:
        return None, FetchResult(
            url=origin_url, ok=False, error=f"Network error while fetching URL: {exc}"
        )

    return None, _evaluate_response_text(origin_url, target.original_url, raw_html, max_chars)


async def fetch_text(url: str, client: httpx.AsyncClient, max_chars: int = 20_000) -> FetchResult:
    """Fetch a public URL pinned to its validated IP across <= 5 redirects and <= 2 MB."""
    current_url = url.strip()

    for redirect_count in range(MAX_REDIRECTS + 1):
        target, safety_error = await _resolve_pinned_target(current_url)
        if safety_error or target is None:
            return FetchResult(url=url, ok=False, error=safety_error or "Invalid URL.")

        next_url, result = await _stream_once(url, target, client, max_chars)
        if result is not None:
            return result
        if redirect_count >= MAX_REDIRECTS or next_url is None:
            return FetchResult(
                url=url, ok=False, error=f"Too many redirects (exceeded {MAX_REDIRECTS})."
            )
        current_url = next_url

    return FetchResult(url=url, ok=False, error=f"Too many redirects (exceeded {MAX_REDIRECTS}).")


def untrusted(text: str, source: str) -> str:
    """Sanitize instruction-like patterns and wrap untrusted text in XML delimiters."""
    cleaned = text
    for pattern in _INJECTION_PATTERNS:
        cleaned = pattern.sub("[REDACTED]", cleaned)
    safe_source = html.escape(source.strip(), quote=True)
    return f'<untrusted_content source="{safe_source}">\n{cleaned.strip()}\n</untrusted_content>'


def make_fetch_tool(client: httpx.AsyncClient) -> BaseTool:
    """Create the LangChain 'fetch_url' tool bound to the provided httpx.AsyncClient."""

    async def _run_fetch(url: str) -> str:
        res = await fetch_text(url=url, client=client)
        if not res.ok:
            return f"Fetch failed for {url}: {res.error}"
        combined = f"{res.title}\n\n{res.text}".strip() if res.title else res.text
        return untrusted(combined, source=res.url)

    return StructuredTool.from_function(
        coroutine=_run_fetch,
        name="fetch_url",
        description="Fetch a public web page URL and return its sanitized readable text.",
    )
