"""The candidate's documents as text, and the documents after the user's decisions: the
one place that knows how a proposal's target maps onto a profile."""

import re

from pydantic import BaseModel, Field

from agent.linkedin_guidance import guidance_for
from agent.schemas import (
    Action,
    Bullet,
    CandidateProfile,
    Decision,
    Document,
    Experience,
    LinkedInGuidance,
    LinkedInProfile,
    Proposal,
)
from agent.sections import role_sections

BULLET_ID = re.compile(r"^exp(\d+)\.b(\d+)$")
NEW_BULLET = re.compile(r"^new:exp(\d+)$")
ROLE_ID = re.compile(r"^(exp|li)(\d+)$")
RESUME_SECTIONS = {"summary", "headline", "skills"}
LINKEDIN_SECTIONS = {"headline", "about", "skills"}
ENTRY_FIELD = re.compile(r"^exp(\d+)\.(title|organization|location|start|end|source_section)$")
EDUCATION_FIELD = re.compile(r"^edu(\d+)\.(degree|institution|year|details)$")
LIST_SECTIONS = {"skills", "certifications", "languages", "other"}


def assign_ids(profile: CandidateProfile, linkedin: LinkedInProfile | None) -> None:
    """Give every role and bullet the stable id proposals point at (in place)."""
    for i, role in enumerate(profile.experience):
        role.id = f"exp{i}"
        for j, bullet in enumerate(role.bullets):
            bullet.id = f"exp{i}.b{j}"
    if linkedin:
        for i, role in enumerate(linkedin.experience):
            role.id = f"li{i}"
            for j, bullet in enumerate(role.bullets):
                bullet.id = f"li{i}.b{j}"


def role_text(role: Experience) -> str:
    """A role as a few lines of text."""
    dates = " – ".join(part for part in (role.start, role.end) if part)
    head = " | ".join(part for part in (role.title, role.organization, dates) if part)
    return "\n".join([head, *(f"- {bullet.text}" for bullet in role.bullets)])


def original_of(
    target: str, document: Document, profile: CandidateProfile, linkedin: LinkedInProfile | None
) -> str | None:
    """The current text a proposal's target points at, '' for an addition, or None
    when the target doesn't exist in that document."""
    if document is Document.RESUME:
        return _resume_original(target, profile)
    return _linkedin_original(target, profile, linkedin)


def _resume_original(target: str, profile: CandidateProfile) -> str | None:
    if target in LIST_SECTIONS:
        separator = ", " if target == "skills" else "\n"
        return separator.join(getattr(profile, target))
    if target in RESUME_SECTIONS:
        return getattr(profile, target)
    if match := BULLET_ID.match(target):
        role, bullet = (int(group) for group in match.groups())
        if role < len(profile.experience) and bullet < len(profile.experience[role].bullets):
            return profile.experience[role].bullets[bullet].text
        return None
    if match := NEW_BULLET.match(target):
        return "" if int(match.group(1)) < len(profile.experience) else None
    for pattern, entries in (
        (ENTRY_FIELD, profile.experience),
        (EDUCATION_FIELD, profile.education),
    ):
        if match := pattern.match(target):
            index, field = int(match.group(1)), match.group(2)
            return getattr(entries[index], field) if index < len(entries) else None
    return None


def _linkedin_original(
    target: str, profile: CandidateProfile, linkedin: LinkedInProfile | None
) -> str | None:
    if target in LINKEDIN_SECTIONS:
        value = getattr(linkedin, target) if linkedin else ""
        return ", ".join(value) if isinstance(value, list) else value
    if match := ROLE_ID.match(target):
        kind, index = match.group(1), int(match.group(2))
        roles = linkedin.experience if kind == "li" and linkedin else profile.experience
        if kind == "li" and not linkedin:
            return None
        return (
            "\n".join(f"- {b.text}" for b in roles[index].bullets) if index < len(roles) else None
        )
    return None


def profile_markdown(profile: CandidateProfile) -> str:
    """A resume as Markdown: single column, ATS-safe, in the usual section order."""
    lines = [f"# {profile.name}" if profile.name else "# Resume"]
    if profile.headline:
        lines.append(f"**{profile.headline}**")
    if profile.contact:
        lines.append(" · ".join(profile.contact))
    if profile.summary:
        lines += ["", "## Summary", profile.summary]
    lines += _experience_markdown(profile)
    lines += _education_markdown(profile)
    if profile.skills:
        lines += ["", "## Skills", ", ".join(profile.skills)]
    for title, items in (
        ("Certifications", profile.certifications),
        ("Languages", profile.languages),
        ("Other", profile.other),
    ):
        if items:
            lines += ["", f"## {title}", *(f"- {item}" for item in items)]
    return "\n".join(lines).strip() + "\n"


def _experience_markdown(profile: CandidateProfile) -> list[str]:
    if not profile.experience:
        return []
    lines = []
    for heading, roles in role_sections(profile):
        lines += ["", f"## {heading}"]
        for role in roles:
            dates = " – ".join(part for part in (role.start, role.end) if part)
            where = ", ".join(part for part in (role.organization, role.location) if part)
            title = f"{role.title} — {where}" if where else role.title
            lines += ["", f"### {title}"]
            if dates:
                lines.append(f"*{dates}*")
            lines += [f"- {bullet.text}" for bullet in role.bullets]
    return lines


def _education_markdown(profile: CandidateProfile) -> list[str]:
    if not profile.education:
        return []
    lines = ["", "## Education"]
    for school in profile.education:
        year = f" ({school.year})" if school.year else ""
        details = f" — {school.details}" if school.details else ""
        lines.append(f"- **{school.degree}**, {school.institution}{year}{details}")
    return lines


class FinalDocuments(BaseModel):
    """The resume with the accepted changes, and the LinkedIn copy to paste."""

    resume: CandidateProfile
    linkedin: dict[str, str]  # target ('headline', 'about', 'li0'/'exp0') -> text
    linkedin_guidance: dict[str, LinkedInGuidance] = Field(default_factory=dict)


def final_text(proposal: Proposal, decision: Decision | None) -> str | None:
    """The text a decision keeps for a proposal, or None when it isn't applied."""
    if decision is None or decision.action is Action.REJECT:
        return None
    if decision.action is Action.EDIT and decision.text.strip():
        return decision.text.strip()
    return proposal.proposed


def apply_decisions(
    profile: CandidateProfile,
    linkedin: LinkedInProfile | None,
    proposals: dict[str, Proposal],
    decisions: dict[str, Decision],
) -> FinalDocuments:
    """The documents with every accepted or edited proposal applied."""
    resume = profile.model_copy(deep=True)
    copy: dict[str, str] = {}
    if linkedin:
        copy["headline"], copy["about"] = linkedin.headline, linkedin.about
    for proposal in proposals.values():
        text = final_text(proposal, decisions.get(proposal.id))
        if text is None:
            continue
        if proposal.document is Document.LINKEDIN:
            copy[proposal.target] = text
        else:
            _apply_to_resume(resume, proposal.target, text)
    guidance = {
        target: LinkedInGuidance(**guidance_for(target, resume, linkedin)) for target in copy
    }
    return FinalDocuments(resume=resume, linkedin=copy, linkedin_guidance=guidance)


def _apply_to_resume(resume: CandidateProfile, target: str, text: str) -> None:
    if target in LIST_SECTIONS:
        pattern = r"[,\n•;]" if target == "skills" else r"\n"
        items = [re.sub(r"^[-•]\s+", "", s.strip()) for s in re.split(pattern, text) if s.strip()]
        setattr(resume, target, items)
    elif target in RESUME_SECTIONS:
        setattr(resume, target, text)
    elif match := BULLET_ID.match(target):
        role, bullet = (int(group) for group in match.groups())
        resume.experience[role].bullets[bullet].text = text
    elif match := NEW_BULLET.match(target):
        role = resume.experience[int(match.group(1))]
        role.bullets.append(Bullet(id=f"{role.id}.b{len(role.bullets)}", text=text))
    else:
        _apply_field(resume, target, text)


def _apply_field(resume: CandidateProfile, target: str, text: str) -> None:
    """Apply a reviewed entry or education field without changing ids or kinds."""
    for pattern, entries in ((ENTRY_FIELD, resume.experience), (EDUCATION_FIELD, resume.education)):
        if match := pattern.match(target):
            setattr(entries[int(match.group(1))], match.group(2), text)
