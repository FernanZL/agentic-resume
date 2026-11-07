"""Deterministic ATS utilities and web research tools for the resume optimizer."""

from agent.tools.ats import (
    Coverage,
    format_issues,
    keyword_coverage,
    normalize,
    numbers_in,
    placeholders_in,
    replace_unsupported_numbers,
    unsupported_numbers,
)
from agent.tools.fetch_url import (
    MAX_BYTES,
    MAX_REDIRECTS,
    FetchResult,
    fetch_text,
    make_fetch_tool,
    untrusted,
)
from agent.tools.web_search import make_web_search

__all__ = [
    "MAX_BYTES",
    "MAX_REDIRECTS",
    "Coverage",
    "FetchResult",
    "fetch_text",
    "format_issues",
    "keyword_coverage",
    "make_fetch_tool",
    "make_web_search",
    "normalize",
    "numbers_in",
    "placeholders_in",
    "replace_unsupported_numbers",
    "unsupported_numbers",
    "untrusted",
]
