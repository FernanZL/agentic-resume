"""The final documents as files: an ATS-safe single-column DOCX of the resume, and
Markdown with the resume and the LinkedIn copy."""

import io
import re

from agent.render import FinalDocuments, profile_markdown
from agent.schemas import CandidateProfile

LINKEDIN_TITLES = {"headline": "Headline", "about": "About"}


def filename(profile: CandidateProfile, title: str, suffix: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", f"{profile.name or 'resume'} {title}".lower()).strip("-")
    return f"{slug[:80] or 'resume'}.{suffix}"


def markdown(final: FinalDocuments) -> str:
    """The resume, then the LinkedIn copy to paste, as one Markdown file."""
    text = profile_markdown(final.resume)
    if final.linkedin:
        text += "\n---\n\n# LinkedIn\n"
        for target, copy in final.linkedin.items():
            text += f"\n## {LINKEDIN_TITLES.get(target, f'Experience ({target})')}\n\n{copy}\n"
    return text


def docx_bytes(profile: CandidateProfile) -> bytes:
    """The resume as a plain, single-column DOCX that applicant tracking systems parse."""
    import docx
    from docx.shared import Pt

    document = docx.Document()
    style = document.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(10.5)
    document.add_heading(profile.name or "Resume", level=0)
    if profile.headline:
        document.add_paragraph().add_run(profile.headline).bold = True
    if profile.contact:
        document.add_paragraph(" · ".join(profile.contact))
    if profile.summary:
        document.add_heading("Summary", level=1)
        document.add_paragraph(profile.summary)
    _experience(document, profile)
    _education(document, profile)
    if profile.skills:
        document.add_heading("Skills", level=1)
        document.add_paragraph(", ".join(profile.skills))
    for title, items in (
        ("Certifications", profile.certifications),
        ("Languages", profile.languages),
        ("Other", profile.other),
    ):
        if items:
            document.add_heading(title, level=1)
            for item in items:
                document.add_paragraph(item, style="List Bullet")
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _experience(document, profile: CandidateProfile) -> None:
    if not profile.experience:
        return
    document.add_heading("Experience", level=1)
    for role in profile.experience:
        where = ", ".join(part for part in (role.organization, role.location) if part)
        document.add_heading(f"{role.title} — {where}", level=2)
        dates = " – ".join(part for part in (role.start, role.end) if part)
        if dates:
            document.add_paragraph().add_run(dates).italic = True
        for bullet in role.bullets:
            document.add_paragraph(bullet.text, style="List Bullet")


def _education(document, profile: CandidateProfile) -> None:
    if not profile.education:
        return
    document.add_heading("Education", level=1)
    for school in profile.education:
        line = f"{school.degree}, {school.institution}"
        line += f" ({school.year})" if school.year else ""
        line += f" — {school.details}" if school.details else ""
        document.add_paragraph(line)
