"""Retrieve only the supplied public LinkedIn profile through Tavily search."""

import re
from urllib.parse import urlsplit

from langchain_core.tools import BaseTool, StructuredTool
from langchain_tavily import TavilySearch

from agent.tools.fetch_url import untrusted

PROFILE_URL = re.compile(r"https?://(?:[a-z]{2,3}\.)?linkedin\.com/in/[\w%-]+/?", re.I)


def profile_url(text: str) -> str:
    """Return a public profile URL supplied in text, never a guessed identity."""
    match = PROFILE_URL.search(text)
    return canonical_profile(match.group()) if match else ""


def canonical_profile(url: str) -> str:
    """Normalize a profile URL and reject unrelated hosts or paths."""
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or parts.username or parts.password:
        return ""
    if not re.fullmatch(r"(?:[a-z]{2,3}\.)?linkedin\.com", parts.netloc, re.I):
        return ""
    if not re.fullmatch(r"/in/[\w%-]+/?", parts.path):
        return ""
    return "https://www.linkedin.com" + parts.path.rstrip("/")


def make_linkedin_search(api_key: str) -> BaseTool:
    """Build an exact-profile search with advanced extraction and bounded public content."""
    client = (
        TavilySearch(
            tavily_api_key=api_key.strip(),
            search_depth="advanced",
            include_domains=["linkedin.com/in"],
            include_raw_content=True,
            max_results=5,
        )
        if api_key.strip()
        else None
    )

    async def search(url: str) -> str:
        """Return the exact requested profile, or explain why an export is needed."""
        requested = canonical_profile(url)
        if not requested:
            return "Unavailable: supply a public linkedin.com/in/ profile URL."
        if client is None:
            return "Unavailable: LinkedIn search is not configured. Upload or paste your profile."
        raw = await client.ainvoke({"query": f'"{requested}"'})
        items = raw.get("results", []) if isinstance(raw, dict) else raw
        for item in items if isinstance(items, list) else []:
            if (
                not isinstance(item, dict)
                or canonical_profile(str(item.get("url", ""))) != requested
            ):
                continue
            content = item.get("raw_content") or item.get("content") or ""
            if isinstance(content, str) and content.strip():
                return untrusted(content[:20_000], requested)
        return (
            "Unavailable: no public content for this exact profile. Upload or paste your profile."
        )

    return StructuredTool.from_function(
        coroutine=search,
        name="linkedin_profile_search",
        description="Retrieve public content for a supplied LinkedIn profile URL through Tavily.",
    )
