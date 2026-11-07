"""The agents' prompts, kept as Markdown files next to this module."""

from functools import cache
from pathlib import Path

PROMPTS = Path(__file__).parent / "prompts"


@cache
def prompt(name: str) -> str:
    """The text of prompts/<name>.md."""
    return (PROMPTS / f"{name}.md").read_text(encoding="utf-8").strip()
