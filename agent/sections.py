"""Shared section grouping and source attribution for resume entries."""

from agent.schemas import CandidateProfile, Experience

HEADINGS = {
    "employment": "Experience",
    "project": "Projects",
    "volunteer": "Volunteering",
    "other": "Additional Experience",
    "unclassified": "Experience",
}


def role_sections(profile: CandidateProfile) -> list[tuple[str, list[Experience]]]:
    """Group consecutive entries under their original headings, retaining stable ids and order."""
    sections: list[tuple[str, list[Experience]]] = []
    for role in profile.experience:
        heading = role.source_section.strip() or HEADINGS[role.kind]
        if not sections or sections[-1][0] != heading:
            sections.append((heading, []))
        sections[-1][1].append(role)
    return sections


def validate_sections(profile: CandidateProfile, source: str) -> list[str]:
    """Reject model-invented source headings without guessing historical entry kinds."""
    lines = {line.strip().lstrip("# ").rstrip(":").casefold() for line in source.splitlines()}
    warnings = []
    for role in profile.experience:
        heading = role.source_section.strip()
        if heading and heading.rstrip(":").casefold() not in lines:
            warnings.append(f"Section for {role.id} was not found in the supplied resume.")
            role.source_section = ""
    return warnings
