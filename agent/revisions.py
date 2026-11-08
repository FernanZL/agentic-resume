"""Content versions for optimistic review submission, independent of chat and events."""

import hashlib
import json


def review_revision(values: dict) -> str:
    """Version the exact proposals and decisions a user is reviewing."""
    content = {
        "proposals": {
            k: p.model_dump(mode="json") for k, p in (values.get("proposals") or {}).items() if p
        },
        "decisions": {
            k: d.model_dump(mode="json") for k, d in (values.get("decisions") or {}).items()
        },
        "reviewed": bool(values.get("analyzed")),
    }
    return hashlib.sha256(
        json.dumps(content, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
