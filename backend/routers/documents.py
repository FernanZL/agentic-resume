"""Uploading the user's documents (parsed in memory; the file is not kept)."""

from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from backend.documents import UnreadableDocument, tidy, to_text
from backend.schemas import DocumentCreated, DocumentKind, DocumentText
from backend.services import Passcode, Svc

router = APIRouter(prefix="/api/documents", tags=["documents"], dependencies=[Passcode])
PREVIEW = 400


def created(document_id: str, kind: DocumentKind, text: str) -> DocumentCreated:
    return DocumentCreated(
        document_id=document_id, kind=kind, characters=len(text), preview=text[:PREVIEW]
    )


@router.post("", status_code=201, operation_id="upload_document")
async def upload_document(
    svc: Svc, kind: Annotated[DocumentKind, Form()], file: Annotated[UploadFile, File()]
) -> DocumentCreated:
    """Upload a resume or LinkedIn export (PDF, DOCX, TXT or MD)."""
    data = await file.read(svc.settings.max_upload_bytes + 1)
    if len(data) > svc.settings.max_upload_bytes:
        raise HTTPException(413, "file_too_large")
    name = file.filename or "document"
    try:
        text = to_text(name, data)
    except UnreadableDocument as error:
        raise HTTPException(415 if str(error) == "unsupported_type" else 422, str(error)) from None
    document_id = await svc.db.add_document(kind, name, text)
    return created(document_id, kind, text)


@router.post("/text", status_code=201, operation_id="paste_document")
async def paste_document(svc: Svc, body: DocumentText) -> DocumentCreated:
    """Paste a resume or LinkedIn profile as text."""
    text = tidy(body.text)
    document_id = await svc.db.add_document(body.kind, "pasted.txt", text)
    return created(document_id, body.kind, text)
