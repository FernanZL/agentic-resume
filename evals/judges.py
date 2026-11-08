"""The model judges of an eval run, on a model from another family than the app's (see
JUDGE_MODEL), so the app is never graded by itself.

- faithfulness: every claim of every proposal, checked against the documents the candidate
  submitted (not the parsed profile, which is itself model output).
- tailoring: how well the improved resume presents the evidence that exists for the role.
  The candidate's missing qualifications are reported as gaps elsewhere; they are not the
  rewrite's fault and do not lower this score.
"""

import json

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from agent.llm import NoStructuredAnswer, structured

JUDGE_MODEL = "google/gemini-3.6-flash"
# Raise when a judge prompt changes: scores from different versions don't compare.
# v2: naming the target role, and equivalent wording of a held title, are not claims.
JUDGE_VERSION = "2"

FAITHFULNESS = (
    "You are a fact-checker for resume rewrites. You get the candidate's SOURCE documents "
    "and a list of PROPOSALS, each replacing an original passage. For each proposal, list "
    "every claim it states or clearly implies that the SOURCE documents do not support: "
    "invented employers, titles, dates, degrees, numbers, tools, responsibilities, scope "
    "(leading a team where the source says 'worked with', a platform where it says a "
    "script), or "
    "outcomes. Rewording, reordering and summarising what the source says are fine. "
    "Placeholders such as [X] are not claims. Neither is naming the role the candidate is "
    "targeting or seeking (a headline or summary aimed at 'Senior Data Engineer' roles), nor "
    "an equivalent wording of a title they hold ('Engineer' for 'Developer'). Quote each "
    "unsupported claim briefly. A "
    "proposal with nothing unsupported gets an empty list. Return one entry per proposal."
)

TAILORING = (
    "You are a senior recruiter for the TARGET role. The candidate's background is fixed: "
    "a qualification missing from the SOURCE documents cannot honestly be added, and it is "
    "reported to the candidate as a gap elsewhere. Do not reward or penalise the "
    "candidate's fit for the role, and do not judge truthfulness (another check does). "
    "Compare the BEFORE and AFTER resumes and judge only how well AFTER presents the "
    "evidence that exists for this role: relevant experience emphasised and ordered first, "
    "the role's language used where the evidence supports it, specific and concrete "
    "bullets, concise, no repetition. Score 1 if AFTER is worse than BEFORE, 2 if it is no "
    "real improvement, 3 if modestly better, 4 if clearly better, 5 if it is about as "
    "strong as this evidence allows. Give a short reason."
)


ATTEMPTS = 2  # a judge sometimes answers in prose; one more try usually gets the schema


async def ask[T: BaseModel](judge: BaseChatModel, schema: type[T], messages: list) -> T:
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return await structured(judge, schema).ainvoke(messages)
        except NoStructuredAnswer:
            if attempt == ATTEMPTS:
                raise
    raise AssertionError("unreachable")


class ProposalCheck(BaseModel):
    proposal_id: str
    unsupported: list[str] = Field(
        default_factory=list, description="Each claim the source does not support, quoted"
    )


class Faithfulness(BaseModel):
    checks: list[ProposalCheck]


class Tailoring(BaseModel):
    score: int = Field(ge=1, le=5)
    reason: str


def source_documents(documents: dict) -> str:
    parts = [f"RESUME:\n{documents['resume']}"]
    if documents.get("linkedin"):
        parts.append(f"LINKEDIN:\n{documents['linkedin']}")
    return "\n\n".join(parts)


async def faithfulness(judge: BaseChatModel, documents: dict, proposals: list[dict]) -> dict:
    """{proposal id: [unsupported claims]} for every proposal (the judge's omissions count
    as unchecked, not as faithful)."""
    asked = [
        {"id": p["id"], "original": p["original"], "proposed": p["proposed"]} for p in proposals
    ]
    verdict = await ask(
        judge,
        Faithfulness,
        [
            SystemMessage(FAITHFULNESS),
            HumanMessage(
                f"SOURCE\n{source_documents(documents)}\n\nPROPOSALS\n{json.dumps(asked)}"
            ),
        ],
    )
    found = {check.proposal_id: check.unsupported for check in verdict.checks}
    return {p["id"]: found.get(p["id"]) for p in proposals}


async def tailoring(judge: BaseChatModel, target: dict, before: str, after: str) -> Tailoring:
    return await ask(
        judge,
        Tailoring,
        [
            SystemMessage(TAILORING),
            HumanMessage(json.dumps({"target": target, "before": before, "after": after})),
        ],
    )
