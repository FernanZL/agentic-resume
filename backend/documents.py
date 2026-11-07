"""Uploaded documents to plain text, in memory: the file itself is never stored."""

import io
import re
from pathlib import PurePath

SUFFIXES = {".pdf", ".docx", ".txt", ".md"}
MIN_CHARACTERS = 50
MAX_CHARACTERS = 60_000


class UnreadableDocument(ValueError):
    """The file couldn't be turned into usable text."""


def to_text(filename: str, data: bytes) -> str:
    """The text of a PDF, DOCX, TXT or Markdown file, tidied."""
    suffix = PurePath(filename).suffix.lower()
    if suffix not in SUFFIXES:
        raise UnreadableDocument("unsupported_type")
    try:
        if suffix == ".pdf":
            text = _pdf(data)
        elif suffix == ".docx":
            text = _docx(data)
        else:
            text = data.decode("utf-8", errors="replace")
    except UnreadableDocument:
        raise
    except Exception as error:  # noqa: BLE001  a corrupt file is the user's error, not ours
        raise UnreadableDocument("unreadable_file") from error
    text = tidy(text)
    if len(text) < MIN_CHARACTERS:
        raise UnreadableDocument("no_text_found")  # e.g. a scanned PDF with no text layer
    return text[:MAX_CHARACTERS]


def tidy(text: str) -> str:
    text = text.replace("\x00", "").replace("\r\n", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _pdf(data: bytes) -> str:
    import pymupdf

    with pymupdf.open(stream=data, filetype="pdf") as document:
        return "\n\n".join(page.get_text("text") for page in document)


def _docx(data: bytes) -> str:
    import docx

    document = docx.Document(io.BytesIO(data))
    parts = [paragraph.text for paragraph in document.paragraphs]
    for table in document.tables:
        for row in table.rows:
            parts.append(" | ".join(cell.text.strip() for cell in row.cells))
    return "\n".join(parts)
