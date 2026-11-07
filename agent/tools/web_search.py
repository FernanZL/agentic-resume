"""Tavily web search tool wrapper with untrusted-content sanitization."""

from typing import Any

from langchain_core.tools import BaseTool, StructuredTool
from langchain_tavily import TavilySearch

from agent.tools.fetch_url import untrusted

_NOT_CONFIGURED_MSG = "Web search is not configured."
_MAX_RESULTS = 5


def _extract_items(raw: Any) -> list[dict[str, Any]]:
    """Normalize TavilySearch output into a list of result dicts."""
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        results = raw.get("results", [])
        if isinstance(results, list):
            return [item for item in results if isinstance(item, dict)]
    return []


def _format_results(raw: Any) -> str:
    """Format up to 5 search results with each entry wrapped in untrusted()."""
    items = _extract_items(raw)[:_MAX_RESULTS]
    if not items:
        if isinstance(raw, str) and raw.strip():
            return untrusted(raw.strip(), source="web_search")
        return "No search results found."

    blocks: list[str] = []
    for item in items:
        title = str(item.get("title") or "").strip()
        url = str(item.get("url") or "web_search").strip()
        snippet = str(item.get("content") or item.get("snippet") or "").strip()
        body = f"Title: {title}\nURL: {url}\nSnippet: {snippet}".strip()
        blocks.append(untrusted(body, source=url))
    return "\n\n".join(blocks)


def make_web_search(api_key: str) -> BaseTool:
    """Create the 'web_search' LangChain tool using Tavily or a safe stub if unconfigured."""
    clean_key = api_key.strip()
    if not clean_key:

        def _unconfigured(query: str) -> str:
            return _NOT_CONFIGURED_MSG

        async def _unconfigured_async(query: str) -> str:
            return _NOT_CONFIGURED_MSG

        return StructuredTool.from_function(
            func=_unconfigured,
            coroutine=_unconfigured_async,
            name="web_search",
            description="Search the web for company, job, or market information.",
        )

    tavily = TavilySearch(max_results=_MAX_RESULTS, tavily_api_key=clean_key)

    def _search(query: str) -> str:
        raw = tavily.invoke({"query": query})
        return _format_results(raw)

    async def _search_async(query: str) -> str:
        raw = await tavily.ainvoke({"query": query})
        return _format_results(raw)

    return StructuredTool.from_function(
        func=_search,
        coroutine=_search_async,
        name="web_search",
        description="Search the web for company, job, or market information.",
    )
