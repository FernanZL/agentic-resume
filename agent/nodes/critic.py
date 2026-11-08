"""The critic: numbers checked against the documents in code, everything else judged by
the model. Flagged proposals go back to their writer, for at most MAX_ROUNDS checks in
all; whatever is still flagged then reaches the user marked, with unverifiable numbers
replaced by placeholders."""

import json
import re

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

from agent.events import emit, step
from agent.linkedin_guidance import copy_issues
from agent.llm import Models, structured
from agent.nodes.gap import job_keywords
from agent.nodes.writers import NODES as WRITERS
from agent.prompts import prompt
from agent.render import apply_decisions, profile_markdown
from agent.schemas import Action, Decision, Document, Proposal, ProposalStatus
from agent.state import AnalysisState
from agent.tools import ats
from agent.tools.fetch_url import untrusted

MAX_ROUNDS = 3  # the first check and two rewrites
UNCHECKED = "The critic gave no verdict on this one; check it yourself."
AGAIN = "Needs another pass."
REPLACED = (
    "Numbers we couldn't find in your documents were replaced with [X]: fill in the real ones."
)
# Copy that talks about the posting instead of the candidate: the writer's reasoning leaking
# into the text ("…Airflow, the Airflow option in the role's Airflow or Dagster requirement").
META = re.compile(
    r"\b(?:the|this)\s+(?:role|posting|position|job(?:\s+(?:ad|description|posting))?)['’]s\b"
    r"|\b(?:the|this)\s+(?:job\s+(?:description|posting|ad)|posting)\b"
    r"|\b(?:the|this)\s+(?:role|position|posting)\s+(?:requires|asks\s+for|calls\s+for)\b"
    r"|\brequirements?\s+(?:of|for|in)\s+(?:the|this)\s+(?:role|position|posting|job)\b",
    re.IGNORECASE,
)
META_ISSUE = (
    "This text talks about the job posting instead of the candidate: keep the reasoning in "
    "the rationale."
)
# A summary sharing this many consecutive words with a bullet is a copy, not a summary.
COPIED_WORDS = 6


class Verdict(BaseModel):
    proposal_id: str
    ok: bool
    issues: list[str] = []


class Verdicts(BaseModel):
    verdicts: list[Verdict]


def sources(state: AnalysisState) -> str:
    """Everything the candidate gave us: the only evidence a number can come from."""
    documents = state["documents"]
    return "\n".join([documents["resume"], documents.get("linkedin", ""), state["target"].notes])


def number_issues(proposal: Proposal, evidence: str) -> list[str]:
    unsupported = ats.unsupported_numbers(proposal.proposed, evidence)
    return [f"Numbers not found in your documents: {', '.join(unsupported)}"] if unsupported else []


def attribution_issues(proposal: Proposal, state: AnalysisState) -> list[str]:
    """Prevent project evidence from being attributed to an unrelated employment entry."""
    roles = {r.id: r for r in state["profile"].experience}
    target = roles.get(proposal.target.removeprefix("new:").split(".")[0])
    refs = [
        roles[ref.split(".")[0]] for ref in proposal.evidence_refs if ref.split(".")[0] in roles
    ]
    if (
        target
        and target.kind == "employment"
        and any(r.kind == "project" and r.id != target.id for r in refs)
    ):
        return ["Project evidence cannot be presented as work performed in this employment entry."]
    if (
        target
        and target.kind == "project"
        and re.search(
            r"\b(?:employed by|hired by|employee (?:at|of)|paid role at)\b", proposal.proposed, re.I
        )
    ):
        return ["This source entry is a project, not confirmed employment."]
    return []


def meta_issues(proposal: Proposal) -> list[str]:
    return [META_ISSUE] if META.search(proposal.proposed) else []


def _words(text: str) -> list[str]:
    return re.findall(r"[\w+#]+", text.lower())


def _runs(words: list[str], n: int) -> set[tuple[str, ...]]:
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


def copied_bullets(summary: str, bullets: list[str]) -> list[str]:
    """The bullets the summary shares COPIED_WORDS consecutive words with."""
    runs = _runs(_words(summary), COPIED_WORDS)
    return [b for b in bullets if runs & _runs(_words(b), COPIED_WORDS)]


def repetition_issues(proposal: Proposal, state: AnalysisState) -> list[str]:
    """A resume summary must summarise, not repeat the bullets right below it (the
    original ones or the proposed rewrites)."""
    if proposal.document is not Document.RESUME or proposal.target != "summary":
        return []
    bullets = [b.text for role in state["profile"].experience for b in role.bullets]
    bullets += [
        p.proposed
        for p in (state.get("proposals") or {}).values()
        if p and p.document is Document.RESUME and ("." in p.target or p.target.startswith("new:"))
    ]
    copied = copied_bullets(proposal.proposed, bullets)
    if not copied:
        return []
    return [
        f"The summary repeats a bullet ('{copied[0]}'): sum up the strongest evidence in new "
        "words instead of restating it."
    ]


def deterministic_issues(proposal: Proposal, state: AnalysisState) -> list[str]:
    """Apply numerical, attribution and copy rules independently of model verdicts."""
    issues = number_issues(proposal, sources(state)) + attribution_issues(proposal, state)
    issues += meta_issues(proposal) + repetition_issues(proposal, state)
    if proposal.document is Document.LINKEDIN:
        issues += copy_issues(proposal.target, proposal.proposed, state["profile"])
        issues += description_issues(proposal, state)
    return issues


def description_issues(proposal: Proposal, state: AnalysisState) -> list[str]:
    """Keep role metadata out of the LinkedIn description paste field."""
    target = proposal.target
    if not re.fullmatch(r"(?:exp|li)\d+", target):
        return []
    roles = (
        state["linkedin"].experience
        if target.startswith("li") and state.get("linkedin")
        else state["profile"].experience
    )
    index = int(target.removeprefix("exp").removeprefix("li"))
    if index >= len(roles):
        return []
    role = roles[index]
    first = proposal.proposed.splitlines()[0].strip() if proposal.proposed.strip() else ""
    metadata = [part for part in (role.title, role.organization, role.start, role.end) if part]
    if ("|" in first and sum(part in first for part in metadata) >= 2) or first.lower().startswith(
        ("title:", "company:", "dates:")
    ):
        return [
            "Paste only description text here; remove title, company and dates from this field."
        ]
    return []


def with_placeholders(proposal: Proposal, evidence: str) -> Proposal:
    """The proposal with every unsupported number replaced, whole token by whole token,
    by [X]."""
    text, replaced = ats.replace_unsupported_numbers(proposal.proposed, evidence)
    if not replaced:
        return proposal
    return proposal.model_copy(
        update={
            "proposed": text,
            "placeholders": ats.placeholders_in(text),
            "issues": [*proposal.issues, REPLACED],
        }
    )


def to_check(state: AnalysisState) -> dict[str, Proposal]:
    """The first round checks every proposal; later rounds only the rewritten ones."""
    proposals = {pid: p for pid, p in (state.get("proposals") or {}).items() if p}
    if not state.get("critique_rounds"):
        return proposals
    return {pid: proposals[pid] for pid in state.get("critique") or {} if pid in proposals}


def keyword_issues(state: AnalysisState, checking: dict[str, Proposal]) -> dict[str, list[str]]:
    """Flag rewrites that omit supported keywords or remove previously matched ones."""
    proposals = {pid: p for pid, p in (state.get("proposals") or {}).items() if p}
    keywords = job_keywords(state.get("reports") or {})
    before = ats.keyword_coverage(profile_markdown(state["profile"]), keywords)
    expected = list(dict.fromkeys([*before.matched, *(state.get("keyword_evidence") or {})]))
    final = apply_decisions(
        state["profile"],
        None,
        proposals,
        {pid: Decision(action=Action.ACCEPT) for pid in proposals},
    )
    missing = ats.keyword_coverage(profile_markdown(final.resume), expected).missing
    carrier = keyword_carrier(checking)
    if not missing or carrier is None:
        return {}
    issue = (
        "The proposed resume omits supported keywords: "
        + ", ".join(missing)
        + ". Use each once, here, where the evidence supports it; don't add it to other bullets."
    )
    return {carrier: [issue]}


KEYWORD_CARRIERS = ("summary", "skills", "headline")


def keyword_carrier(checking: dict[str, Proposal]) -> str | None:
    """The one resume proposal that is asked for the missing keywords: the summary, else
    the skills, else the headline, else any. Asking every bullet made the writer append
    the same keywords to all of them."""
    resume = {p.target: pid for pid, p in checking.items() if p.document is Document.RESUME}
    for target in KEYWORD_CARRIERS:
        if target in resume:
            return resume[target]
    return next(iter(resume.values()), None)


async def judge(
    models: Models, state: AnalysisState, proposals: dict[str, Proposal], config: dict | None = None
) -> dict[str, list[str]]:
    """The model's issues per proposal id (only for the proposals asked about)."""
    if not proposals:
        return {}
    payload = [
        p.model_dump(include={"id", "document", "target", "original", "proposed"})
        for p in proposals.values()
    ]
    verdicts: Verdicts = await structured(models.critic, Verdicts).ainvoke(
        [
            SystemMessage(prompt("critic")),
            HumanMessage(untrusted(state["profile"].model_dump_json(), "original profile")),
            HumanMessage(untrusted(state["documents"]["resume"], "supplied resume")),
            HumanMessage("Proposals to check:\n" + json.dumps(payload, ensure_ascii=False)),
        ],
        config=config,
    )
    issues = {pid: [UNCHECKED] for pid in proposals}  # no verdict is not a pass
    for verdict in verdicts.verdicts:
        if verdict.proposal_id in proposals:
            issues[verdict.proposal_id] = [] if verdict.ok else verdict.issues or [AGAIN]
    return {pid: found for pid, found in issues.items() if found}


def make_critic(models: Models):
    @step("critic")
    async def critic(state: AnalysisState) -> dict:
        rounds = state.get("critique_rounds", 0) + 1
        checking = to_check(state)
        evidence = sources(state)
        flagged = {pid: deterministic_issues(p, state) for pid, p in checking.items()}
        for pid, issues in keyword_issues(state, checking).items():
            flagged[pid] = [*flagged[pid], *issues]
        for pid, issues in (await judge(models, state, checking)).items():
            flagged[pid] = [*flagged[pid], *issues]
        flagged = {pid: issues for pid, issues in flagged.items() if issues}
        last = rounds >= MAX_ROUNDS
        updates: dict[str, Proposal] = {}
        for pid, proposal in checking.items():
            if pid not in flagged:
                updates[pid] = proposal.model_copy(
                    update={"status": ProposalStatus.OK, "issues": []}
                )
                continue
            marked = proposal.model_copy(
                update={"status": ProposalStatus.FLAGGED, "issues": flagged[pid]}
            )
            updates[pid] = with_placeholders(marked, evidence) if last else marked
        emit(
            "critique",
            "critic",
            round=rounds,
            flagged_ids=sorted(flagged),
            final=last or not flagged,
        )
        return {
            "proposals": updates,
            "critique": {} if last else flagged,
            "critique_rounds": rounds,
        }

    return critic


def after_critic(state: AnalysisState) -> list[str] | str:
    """Back to the writers whose proposals are flagged, or on to the review."""
    flagged = state.get("critique") or {}
    writers = [
        WRITERS[doc] for doc in Document if any(pid.startswith(f"{doc.value}:") for pid in flagged)
    ]
    return writers or "review"
