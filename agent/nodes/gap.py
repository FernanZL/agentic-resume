"""The gap analysis: keyword coverage and format checks counted in code, then a
recruiter's rubric from the model on what code can't see."""

import json

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


def job_keywords(reports: dict[str, Report]) -> list[str]:
    """The terms to match: the posting's keywords and must-haves, else the market's
    in-demand skills; de-duplicated, in order."""
    job = reports.get("job")
    terms: list[str] = []
    if job and job.job:
        terms = [*job.job.keywords, *job.job.must_have]
    if not terms and (market := reports.get("market")) and market.market:
        terms = list(market.market.in_demand_skills)
    seen: dict[str, str] = {}
    for term in terms:
        seen.setdefault(ats.normalize(term), term)
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
