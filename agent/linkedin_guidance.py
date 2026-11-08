"""Versioned, explicitly advisory placement guidance for reviewed LinkedIn copy."""

from urllib.parse import urlsplit

from agent.schemas import CandidateProfile, LinkedInProfile

# These are editor recommendations, not claims of live-verified platform restrictions.
FIELDS = {
    "headline": ("Intro", "Headline", 220),
    "about": ("About", "About text", 2600),
    "skills": ("Skills", "Individual skills", None),
}
HELP_URL = "https://www.linkedin.com/help/linkedin"


def guidance_for(
    target: str, profile: CandidateProfile, linkedin: LinkedInProfile | None = None
) -> dict:
    """Describe where approved text belongs without claiming to have edited the profile."""
    section, field, limit = FIELDS.get(target, ("Experience", "Description", 2000))
    roles = linkedin.experience if target.startswith("li") and linkedin else profile.experience
    index = target.removeprefix("exp").removeprefix("li")
    if index.isdigit() and int(index) < len(roles):
        role = roles[int(index)]
        label = "Projects" if role.kind == "project" else "Experience"
        section = " · ".join(x for x in (label, role.title, role.organization) if x)
    instructions = (
        "Open your LinkedIn profile and edit this section. "
        "Paste the reviewed text into this field. "
        "Check the preview and save. The interface and available fields can vary."
    )
    if target == "skills":
        instructions = (
            "Open Skills and add the reviewed skills individually. "
            "Keep only skills you can support."
        )
    return {
        "section": section,
        "field": field,
        "instructions": instructions,
        "character_limit": limit,
        "verified": False,
        "source_url": HELP_URL,
        "version": "2026-11-08",
        "status": "advisory_unverified",
    }


def copy_issues(target: str, text: str, profile: CandidateProfile) -> list[str]:
    """Flag text exceeding advisory editor limits instead of silently truncating it."""
    limit = guidance_for(target, profile)["character_limit"]
    return (
        [
            f"Text has {len(text)} characters; recommended editor limit is {limit}. "
            "Shorten and verify in LinkedIn."
        ]
        if limit and len(text) > limit
        else []
    )


def candidate_urls(profile: CandidateProfile) -> list[str]:
    """Use only explicitly supplied portfolio/repository links, never identity search."""
    urls = []
    for contact in profile.contact:
        parts = urlsplit(contact)
        if (
            parts.scheme in {"https", "http"}
            and parts.hostname
            and "linkedin.com" not in parts.hostname
        ):
            urls.append(contact)
    return list(dict.fromkeys(urls))[:2]
