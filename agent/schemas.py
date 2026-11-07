"""The domain models every agent, the API and the web app share: the candidate's
documents as structure, the target job, each researcher's report, the gap analysis,
the proposals and the user's decisions on them. This is the contract; change it only
through the lead."""

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------- the candidate


class Bullet(BaseModel):
    """One line of an experience or project, with an id the proposals point at."""

    id: str = Field(description="Stable id, e.g. 'exp0.b2' (set in code, not by the model)")
    text: str


class Experience(BaseModel):
    """A role (or project) on the resume."""

    id: str = Field(description="Stable id, e.g. 'exp0' (set in code)")
    title: str
    organization: str
    location: str = ""
    start: str = Field("", description="As written on the resume, e.g. 'Mar 2021'")
    end: str = Field("", description="As written, e.g. 'Present'")
    bullets: list[Bullet] = []


class Education(BaseModel):
    """A degree or certification."""

    degree: str
    institution: str
    year: str = ""
    details: str = ""


class CandidateProfile(BaseModel):
    """A resume as structure. Every fact a writer may use comes from here."""

    name: str = ""
    headline: str = Field("", description="Title line under the name, if any")
    contact: list[str] = Field([], description="Email, phone, links, location")
    summary: str = ""
    experience: list[Experience] = []
    education: list[Education] = []
    skills: list[str] = []
    certifications: list[str] = []
    languages: list[str] = []
    other: list[str] = Field([], description="Anything else worth keeping (awards, talks)")


class LinkedInProfile(BaseModel):
    """A LinkedIn profile from its 'Save to PDF' export or pasted text."""

    headline: str = ""
    about: str = ""
    experience: list[Experience] = []
    skills: list[str] = []


class TargetJob(BaseModel):
    """What the candidate is aiming for. Title is required; the rest helps."""

    title: str
    company: str = ""
    job_url: str = ""
    job_text: str = Field("", description="The posting's text, pasted by the user")
    notes: str = Field("", description="Seniority, region, anything the user told the chat")


# ---------------------------------------------------------------- research


class ReportKind(StrEnum):
    JOB = "job"
    COMPANY = "company"
    MARKET = "market"
    LINKEDIN = "linkedin"


class Source(BaseModel):
    title: str = ""
    url: str


class JobAnalysis(BaseModel):
    """What the role asks for."""

    summary: str
    seniority: str = ""
    must_have: list[str] = []
    nice_to_have: list[str] = []
    responsibilities: list[str] = []
    keywords: list[str] = Field([], description="Exact terms an ATS would match on")
    sources: list[Source] = []


class CompanyBrief(BaseModel):
    """What the company is and how it talks."""

    summary: str
    products: list[str] = []
    tech_stack: list[str] = []
    values: list[str] = []
    tone: str = ""
    recent_news: list[str] = []
    sources: list[Source] = []


class MarketBrief(BaseModel):
    """How the market names and values this kind of role."""

    summary: str
    title_variants: list[str] = []
    in_demand_skills: list[str] = []
    level_signals: list[str] = []
    sources: list[Source] = []


class LinkedInAudit(BaseModel):
    """Where the LinkedIn profile falls short of the resume and the target."""

    summary: str
    headline_issues: list[str] = []
    about_issues: list[str] = []
    experience_gaps: list[str] = Field([], description="On the resume but not on LinkedIn")
    inconsistencies: list[str] = Field([], description="Dates/titles that disagree")


class Report(BaseModel):
    """A researcher's result. Exactly one of the bodies is set, matching kind; a
    researcher that failed sets error instead, and the run goes on without it."""

    kind: ReportKind
    job: JobAnalysis | None = None
    company: CompanyBrief | None = None
    market: MarketBrief | None = None
    linkedin: LinkedInAudit | None = None
    error: str = ""


class GapReport(BaseModel):
    """How the resume matches the job, part counted in code, part judged."""

    score: int = Field(ge=0, le=100, description="Overall match, 0-100")
    keyword_coverage: float = Field(ge=0, le=1, description="Share of job keywords found (code)")
    matched_keywords: list[str] = []
    missing_keywords: list[str] = []
    format_issues: list[str] = Field([], description="ATS format problems (code)")
    weak_bullets: list[str] = Field([], description="Bullet ids that need work")
    strengths: list[str] = []
    priorities: list[str] = Field([], description="What to fix first, in order")


# ---------------------------------------------------------------- proposals


class Document(StrEnum):
    RESUME = "resume"
    LINKEDIN = "linkedin"


class ProposalStatus(StrEnum):
    OK = "ok"  # passed the critic
    FLAGGED = "flagged"  # the critic still has issues after its last round


class Proposal(BaseModel):
    """One suggested change. Its id is '<document>:<target>' so a rewrite of the same
    target replaces it instead of adding a duplicate."""

    id: str
    document: Document
    target: str = Field(
        description=(
            "What it changes: 'summary', 'headline', 'skills', 'about', "
            "an experience id ('exp0') or a bullet id ('exp0.b2'), or 'new:exp0' to add a bullet"
        )
    )
    original: str = ""
    proposed: str
    rationale: str
    keywords: list[str] = []
    placeholders: list[str] = Field([], description="e.g. '[X]%' the user must fill in")
    issues: list[str] = Field([], description="The critic's remaining concerns")
    status: ProposalStatus = ProposalStatus.OK


class Action(StrEnum):
    ACCEPT = "accept"
    REJECT = "reject"
    EDIT = "edit"


class Decision(BaseModel):
    action: Action
    text: str = Field("", description="The user's own wording, for edit")


ReviewResume = dict[str, Decision]
"""What the review step resumes with: a decision per proposal id. Proposals with no
decision count as rejected."""


ConciergeRole = Literal["user", "assistant"]
