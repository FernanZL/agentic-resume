"""The final documents as files: an ATS-safe single-column DOCX of the resume, and
Markdown with the resume and the LinkedIn copy."""

import html
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


PRINT_CSS = """
@page { size: A4; margin: 16mm 18mm; }
body { font: 10.5pt/1.45 Georgia, 'Times New Roman', serif; color: #111; max-width: 780px;
       margin: 24px auto; padding: 0 16px; }
h1 { font-size: 20pt; margin: 0; } h2 { font-size: 11pt; text-transform: uppercase;
     letter-spacing: .08em; border-bottom: 1px solid #999; margin: 18px 0 6px; }
h3 { font-size: 10.5pt; margin: 10px 0 0; } .muted { color: #444; } ul { margin: 4px 0; }
.linkedin { page-break-before: always; } pre { white-space: pre-wrap; font: inherit; }
@media print { body { margin: 0; padding: 0; } }
"""


def html_page(final: FinalDocuments) -> str:
    """The resume (then the LinkedIn copy on its own page) as one escaped HTML page to
    print or save as PDF: single column, no scripts."""
    r, e = final.resume, html.escape
    parts = [f"<h1>{e(r.name or 'Resume')}</h1>"]
    if r.headline:
        parts.append(f"<p><strong>{e(r.headline)}</strong></p>")
    if r.contact:
        parts.append(f"<p class='muted'>{e(' · '.join(r.contact))}</p>")
    if r.summary:
        parts.append(f"<h2>Summary</h2><p>{e(r.summary)}</p>")
    if r.experience:
        parts.append("<h2>Experience</h2>")
    for role in r.experience:
        where = ", ".join(x for x in (role.organization, role.location) if x)
        dates = " – ".join(x for x in (role.start, role.end) if x)
        bullets = "".join(f"<li>{e(b.text)}</li>" for b in role.bullets)
        parts.append(
            f"<h3>{e(role.title)} — {e(where)}</h3><p class='muted'>{e(dates)}</p>"
            f"<ul>{bullets}</ul>"
        )
    parts += _html_lists(r)
    if final.linkedin:
        blocks = "".join(
            f"<h2>{e(LINKEDIN_TITLES.get(t, f'Experience ({t})'))}</h2><pre>{e(c)}</pre>"
            for t, c in final.linkedin.items()
        )
        parts.append(f"<section class='linkedin'><h1>LinkedIn</h1>{blocks}</section>")
    title = e(f"{r.name or 'Resume'} — resume")
    return (
        f"<!doctype html><html lang='en'><head><meta charset='utf-8'><title>{title}</title>"
        f"<meta name='viewport' content='width=device-width, initial-scale=1'>"
        f"<style>{PRINT_CSS}</style></head><body>{''.join(parts)}</body></html>"
    )


def _html_lists(r: CandidateProfile) -> list[str]:
    e = html.escape
    parts = []
    if r.education:
        items = "".join(
            f"<li><strong>{e(s.degree)}</strong>, {e(s.institution)}"
            f"{e(f' ({s.year})' if s.year else '')}</li>"
            for s in r.education
        )
        parts.append(f"<h2>Education</h2><ul>{items}</ul>")
    if r.skills:
        parts.append(f"<h2>Skills</h2><p>{e(', '.join(r.skills))}</p>")
    for title, items in (
        ("Certifications", r.certifications),
        ("Languages", r.languages),
        ("Other", r.other),
    ):
        if items:
            parts.append(f"<h2>{title}</h2><ul>{''.join(f'<li>{e(i)}</li>' for i in items)}</ul>")
    return parts
