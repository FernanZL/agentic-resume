"""The gap analysis: keyword coverage and format checks counted in code, then a
recruiter's rubric from the model on what code can't see."""

import json
import re

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from agent.events import emit, step
from agent.llm import Models, structured
from agent.prompts import prompt
from agent.render import profile_markdown
from agent.schemas import GapReport, Report
from agent.state import AnalysisState
from agent.tools import ats
from agent.tools.fetch_url import untrusted


class Rubric(BaseModel):
    """The model's part of the gap report."""

    score: int = Field(ge=0, le=100)
    weak_bullets: list[str] = Field([], description="Bullet ids, e.g. 'exp0.b2'")
    strengths: list[str] = []
    priorities: list[str] = []
    keyword_evidence: dict[str, str] = Field(
        default_factory=dict,
        description="Missing keyword -> exact quote from candidate documents supporting it. "
        "Only semantic equivalents of existing experience; omit skills the candidate hasn't shown.",
    )


# A keyword is a short term an ATS matches (a skill, tool, method or title). Longer items are
# requirement sentences ("2+ years product management experience"): no resume contains them
# verbatim, so as keywords they could never be matched and would only push rewrites to
# echo the posting.
MAX_KEYWORD_WORDS = 4
DURATION = re.compile(r"\d+\s*\+?\s*(?:years?|yrs?)\b", re.IGNORECASE)
LEAD_IN = re.compile(
    r"^(?:(?:hands-on|proven|strong|solid)\s+)?"
    r"(?:experience|proficiency|familiarity|knowledge|expertise)\s+(?:with|in|of)\s+",
    re.IGNORECASE,
)
ALTERNATIVES = re.compile(r"\s+or\s+|\s+/\s+", re.IGNORECASE)  # "CI/CD" stays whole


def keyword_terms(term: str) -> list[str]:
    """A posting's term as matchable keywords: alternatives split ('Airflow or Dagster'),
    a lead-in dropped ('experience with B2B customers'), and requirement sentences and
    durations left out."""
    if DURATION.search(term):
        return []
    found = []
    for part in ALTERNATIVES.split(LEAD_IN.sub("", term.strip())):
        part = part.strip(" .,;:")
        if part and len(part.split()) <= MAX_KEYWORD_WORDS:
            found.append(part)
    return found


def job_keywords(reports: dict[str, Report]) -> list[str]:
    """The terms to match: the posting's keywords and must-haves, else the market's
    in-demand skills; as short keywords (keyword_terms), de-duplicated, in order."""
    job = reports.get("job")
    terms: list[str] = []
    if job and job.job:
        terms = [*job.job.keywords, *job.job.must_have]
    if not terms and (market := reports.get("market")) and market.market:
        terms = list(market.market.in_demand_skills)
    seen: dict[str, str] = {}
    for term in terms:
        for keyword in keyword_terms(term):
            seen.setdefault(ats.normalize(keyword), keyword)
    return list(seen.values())


def make_gap_analysis(models: Models):
    @step("gap_analysis")
    async def gap_analysis(state: AnalysisState) -> dict:
        profile, reports = state["profile"], state.get("reports", {})
        coverage = ats.keyword_coverage(profile_markdown(profile), job_keywords(reports))
        issues = ats.format_issues(profile)
        findings = {
            "target": state["target"].model_dump(),
            "keyword_coverage": coverage.model_dump(),
            "format_issues": issues,
            "research": {
                kind: report.model_dump(exclude_none=True) for kind, report in reports.items()
            },
        }
        rubric: Rubric = await structured(models.analyst, Rubric).ainvoke(
            [
                SystemMessage(prompt("gap_rubric")),
                HumanMessage(untrusted(profile.model_dump_json(), "resume")),
                HumanMessage(untrusted(state["documents"]["resume"], "supplied resume")),
                HumanMessage(json.dumps(findings, ensure_ascii=False)),
            ]
        )
        bullet_ids = {b.id for role in profile.experience for b in role.bullets}
        source = " ".join(state["documents"]["resume"].split())
        supported = {
            keyword: quote
            for keyword, quote in rubric.keyword_evidence.items()
            if keyword in coverage.missing and quote.strip() and " ".join(quote.split()) in source
        }
        keyword_priorities = [
            f"Use '{keyword}' where supported by: {supported[keyword]}"
            if keyword in supported
            else f"Confirm experience before adding '{keyword}'; no verified evidence yet."
            for keyword in coverage.missing
        ]
        gap = GapReport(
            score=rubric.score,
            keyword_coverage=round(coverage.score, 3),
            matched_keywords=coverage.matched,
            missing_keywords=coverage.missing,
            format_issues=issues,
            weak_bullets=[b for b in rubric.weak_bullets if b in bullet_ids],
            strengths=rubric.strengths,
            priorities=[*keyword_priorities, *rubric.priorities],
        )
        emit("gap_ready", "gap_analysis", score=gap.score, keyword_coverage=gap.keyword_coverage)
        return {"gap": gap, "keyword_evidence": supported}

    return gap_analysis
