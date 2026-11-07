"""The tools the agents work with, built once per process from their clients and
keys, so the graphs never read the environment and tests can give fakes."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from langchain_core.tools import BaseTool

from agent.tools.fetch_url import FetchResult


@dataclass(frozen=True)
class Toolbox:
    web_search: BaseTool  # name "web_search"
    fetch_url: BaseTool  # name "fetch_url"
    fetch: Callable[[str], Awaitable[FetchResult]]  # the posting, fetched in code
