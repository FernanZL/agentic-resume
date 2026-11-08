"""Run the analysis on the golden cases with the real models and score it:

- keyword coverage of the job's keywords, before and after accepting every proposal
- fabrication: proposals that still carry numbers not found in the candidate's documents
- flagged: proposals the critic still has concerns about
- judge: a recruiter's 1-5 rating of the improved resume against the original
- cost and time per case

Usage: uv run python -m evals.run [case ...]   (needs OPENROUTER_API_KEY; results in evals/results/)
"""

import asyncio
import json
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

import httpx
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.types import Command
from pydantic import BaseModel, Field

from agent.checkpoints import memory_saver
from agent.graph import build_graph, run_config
from agent.llm import Models, structured
from agent.nodes.critic import sources
from agent.nodes.gap import job_keywords
from agent.nodes.review import resume_with
from agent.render import apply_decisions, profile_markdown
from agent.schemas import Action, Decision, TargetJob
from agent.state import RunContext
from agent.toolbox import Toolbox
from agent.tools import ats
from backend.budget import usage_from

CASES = Path(__file__).parent / "cases"
RESULTS = Path(__file__).parent / "results"
JUDGE = (
    "You are a senior recruiter for the target role. Compare the ORIGINAL and IMPROVED "
    "resumes. Rate the improvement from 1 (worse or no better) to 5 (clearly stronger for "
    "this role, still truthful). Penalize anything that looks invented."
)


class Rating(BaseModel):
    score: int = Field(ge=1, le=5)
    reason: str


class CostMeter:
    """Adds up what the models report spending (OpenRouter usage), as a callback."""

    def __init__(self):
        from langchain_core.callbacks import AsyncCallbackHandler

        meter = self

        class Handler(AsyncCallbackHandler):
            async def on_llm_end(self, response, **kwargs):
                meter.cost += usage_from(response)[2]

        self.cost = 0.0
        self.handler = Handler()


def load_case(name: str) -> dict:
    return json.loads((CASES / f"{name}.json").read_text())


async def run_case(case: dict, models: Models, toolbox: Toolbox, judge: BaseChatModel) -> dict:
    graph = build_graph(models, toolbox, memory_saver())
    session_id = str(uuid.uuid4())
    meter = CostMeter()
    config = run_config(session_id, "eval", [meter.handler])
    context = RunContext(session_id=session_id, run_id="eval")
    target = TargetJob.model_validate(case["target"])
    first = {
        "documents": {"resume": case["resume"], "linkedin": case.get("linkedin", "")},
        "target": target,
        "messages": [HumanMessage(f"Please tailor my resume for {target.title}.")],
    }
    began = time.monotonic()
    await graph.ainvoke(first, config, context=context)
    state = await graph.aget_state(config, subgraphs=True)
    if not state.interrupts:
        return {"case": case["name"], "error": "the analysis didn't reach the review"}
    analysis = state.tasks[0].state.values
    proposals = {pid: p for pid, p in analysis["proposals"].items() if p}
    accept_all = {pid: Decision(action=Action.ACCEPT).model_dump() for pid in proposals}
    await graph.ainvoke(Command(resume=resume_with(accept_all)), config, context=context)
    values = (await graph.aget_state(config)).values
    return await score(case, values, proposals, judge, meter.cost, time.monotonic() - began)


async def score(case, values, proposals, judge, cost, seconds) -> dict:
    keywords = job_keywords(values["reports"])
    before_text = profile_markdown(values["profile"])
    final = apply_decisions(
        values["profile"], values.get("linkedin"), proposals, values["decisions"]
    )
    after_text = profile_markdown(final.resume)
    structure_errors = structure_failures(case, final.resume)
    before_coverage = ats.keyword_coverage(before_text, keywords)
    after_coverage = ats.keyword_coverage(after_text, keywords)
    supported = ats.keyword_coverage(after_text, list(values.get("keyword_evidence") or {}))
    evidence = sources(values)
    fabricated = [
        pid for pid, p in proposals.items() if ats.unsupported_numbers(p.proposed, evidence)
    ]
    rating: Rating = await structured(judge, Rating).ainvoke(
        [
            SystemMessage(JUDGE),
            HumanMessage(
                json.dumps(
                    {"target": case["target"], "original": before_text, "improved": after_text}
                )
            ),
        ]
    )
    return {
        "case": case["name"],
        "proposals": len(proposals),
        "coverage_before": round(before_coverage.score, 3),
        "coverage_after": round(after_coverage.score, 3),
        "remaining_keywords": after_coverage.missing,
        "supported_keywords_omitted": supported.missing,
        "structure_errors": structure_errors,
        "checks": {
            "coverage_not_regressed": set(before_coverage.matched) <= set(after_coverage.matched),
            "supported_keywords_covered": not supported.missing,
            "no_unsupported_numbers": not fabricated,
            "source_structure_preserved": not structure_errors,
        },
        "fabricated": fabricated,
        "flagged": sum(p.status == "flagged" for p in proposals.values()),
        "match_score": values["gap"].score if values.get("gap") else None,
        "judge": rating.score,
        "judge_reason": rating.reason,
        "research_errors": {k: r.error for k, r in values["reports"].items() if r.error},
        "cost_usd": round(cost, 4),
        "seconds": round(seconds, 1),
    }


def structure_failures(case: dict, profile) -> list[str]:
    """Score labelled source sections and attribution, independently of the model's own verdict."""
    found = {r.title: r for r in profile.experience}
    failures = []
    for expected in case.get("expected_entries", []):
        role = found.get(expected["title"])
        if role is None:
            failures.append(f"Missing source entry: {expected['title']}")
        elif role.kind != expected["kind"] or role.source_section != expected["source_section"]:
            failures.append(f"Incorrect kind or section: {expected['title']}")
    for title, forbidden in case.get("forbidden_entry_terms", {}).items():
        role = found.get(title)
        text = " ".join(b.text for b in role.bullets) if role else ""
        leaked = ats.keyword_coverage(text, forbidden).matched
        if leaked:
            failures.append(
                f"Unrelated entry acquired unsupported role terms: {title}: {', '.join(leaked)}"
            )
    return failures


async def main(names: list[str]) -> list[dict]:
    from backend.services import real_models, real_toolbox
    from backend.settings import load

    settings = load()
    if not settings.openrouter_api_key:
        sys.exit("OPENROUTER_API_KEY is not set")
    models = real_models(settings)
    names = names or sorted(path.stem for path in CASES.glob("*.json"))
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        toolbox = real_toolbox(settings, client)
        results = [
            await run_case(load_case(name), models, toolbox, models.critic) for name in names
        ]
    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / f"{datetime.now(UTC):%Y%m%d-%H%M%S}.json"
    out.write_text(json.dumps(results, indent=2))
    report(results)
    print(f"\nSaved {out}")
    return results


def passes(results: list[dict]) -> bool:
    """Fail the evaluation run when a case errors or a behavioral quality gate fails."""
    return bool(results) and all(
        "error" not in result and bool(result.get("checks")) and all(result["checks"].values())
        for result in results
    )


def report(results: list[dict]) -> None:
    print(
        f"{'case':22} {'props':>5} {'cov before':>10} {'cov after':>9} {'fabr':>4} "
        f"{'flag':>4} {'judge':>5} {'cost $':>7} {'secs':>6}"
    )
    for r in results:
        if "error" in r:
            print(f"{r['case']:22} ERROR {r['error']}")
            continue
        print(
            f"{r['case']:22} {r['proposals']:>5} {r['coverage_before']:>10.0%} "
            f"{r['coverage_after']:>9.0%} {len(r['fabricated']):>4} {r['flagged']:>4} "
            f"{r['judge']:>5} {r['cost_usd']:>7.3f} {r['seconds']:>6.0f}"
        )


if __name__ == "__main__":
    sys.exit(0 if passes(asyncio.run(main(sys.argv[1:]))) else 1)
