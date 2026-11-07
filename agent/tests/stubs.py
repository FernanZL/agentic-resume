"""A stub model whose replies are worked out from each prompt, so the whole graph runs in
tests without a real model, with sample documents and fake tools (undercover's pattern)."""

import itertools
import json
from collections.abc import Callable
from typing import Any

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool

from agent.llm import Models
from agent.schemas import TargetJob
from agent.toolbox import Toolbox
from agent.tools.fetch_url import FetchResult

# What OpenRouter reports for each reply.
USAGE = {"prompt_tokens": 1000, "completion_tokens": 200, "cost": 0.002}
IDS = itertools.count()

RESUME = """Alex Rivera
alex.rivera@example.com · Lisbon
Summary: Backend engineer with 6 years building payment APIs.
Experience
Senior Software Engineer, Fintech Co (2021 - Present)
- Built a payments API in Python serving 2 million requests a day
- Led migration of 12 services to Kubernetes
Software Engineer, Shop Inc (2018 - 2021)
- Maintained checkout service
Skills: Python, Django, PostgreSQL, Docker
"""
LINKEDIN = "Headline: Engineer at Fintech Co\nAbout: I write code."
TARGET = TargetJob(
    title="Staff Backend Engineer",
    company="Acme Payments",
    job_text="We need Python, Kubernetes, Kafka and system design leadership.",
)


def call(name: str, **args: Any) -> AIMessage:
    """A reply that calls one tool (or answers as a structured schema of that name)."""
    return AIMessage(
        content="", tool_calls=[{"name": name, "args": args, "id": f"call-{next(IDS)}"}]
    )


def profile_args() -> dict:
    return {
        "name": "Alex Rivera",
        "contact": ["alex.rivera@example.com", "Lisbon"],
        "summary": "Backend engineer with 6 years building payment APIs.",
        "experience": [
            {
                "id": "",
                "title": "Senior Software Engineer",
                "organization": "Fintech Co",
                "start": "2021",
                "end": "Present",
                "bullets": [
                    {
                        "id": "",
                        "text": "Built a payments API in Python serving 2 million requests a day",
                    },
                    {"id": "", "text": "Led migration of 12 services to Kubernetes"},
                ],
            },
            {
                "id": "",
                "title": "Software Engineer",
                "organization": "Shop Inc",
                "start": "2018",
                "end": "2021",
                "bullets": [{"id": "", "text": "Maintained checkout service"}],
            },
        ],
        "skills": ["Python", "Django", "PostgreSQL", "Docker"],
    }


class Script:
    """The default replies of every role, which a test can override per role."""

    def __init__(self, **overrides: Callable[[list[BaseMessage]], AIMessage]):
        self.overrides = overrides
        self.critic_rounds = 0

    def reply(self, messages: list[BaseMessage]) -> AIMessage:
        system = messages[0].content if messages else ""
        for role, marker in ROLES.items():
            if marker in system:
                handler = self.overrides.get(role) or getattr(self, role)
                return handler(messages)
        raise AssertionError(f"No script for prompt: {system[:80]}")

    def concierge(self, messages: list[BaseMessage]) -> AIMessage:
        if isinstance(messages[-1], HumanMessage):
            return call("request_analysis", title=TARGET.title)
        return AIMessage(content="Your match score is in. Review the proposals on the right.")

    def intake(self, messages):
        has_linkedin = "linkedin" in messages[-1].content
        linkedin = {"headline": "Engineer at Fintech Co", "about": "I write code."}
        return call("Intake", profile=profile_args(), linkedin=linkedin if has_linkedin else None)

    def researcher(self, messages):
        system = messages[0].content
        if isinstance(messages[-1], HumanMessage) and "final answer" in messages[-1].content:
            if "job researcher" in system:
                return call(
                    "JobAnalysis",
                    summary="Staff backend role",
                    seniority="staff",
                    must_have=["Python", "Kubernetes", "Kafka"],
                    keywords=["Python", "Kubernetes", "Kafka", "system design"],
                )
            if "company researcher" in system:
                return call(
                    "CompanyBrief",
                    summary="Payments company",
                    tech_stack=["Go", "Kafka"],
                    sources=[{"title": "Acme", "url": "https://acme.example"}],
                )
            return call("MarketBrief", summary="Strong demand", in_demand_skills=["Kafka", "Go"])
        if not any(isinstance(m, ToolMessage) for m in messages):
            return call("web_search", query="staff backend engineer skills")
        return AIMessage(content="I have enough.")

    def linkedin_auditor(self, messages):
        return call("LinkedInAudit", summary="Headline is vague", headline_issues=["No role focus"])

    def gap(self, messages):
        return call(
            "Rubric",
            score=64,
            weak_bullets=["exp1.b0", "exp9.b9"],
            strengths=["Payments"],
            priorities=["Show Kafka", "Show leadership"],
        )

    def resume_writer(self, messages):
        if "Critic feedback" in messages[-1].content:
            return call(
                "Drafts",
                proposals=[
                    {
                        "target": "exp1.b0",
                        "proposed": "Owned the checkout service end to end, "
                        "improving reliability by [X]%",
                        "rationale": "Ownership",
                    }
                ],
            )
        return call(
            "Drafts",
            proposals=[
                {
                    "target": "summary",
                    "proposed": "Backend engineer with 6 years building "
                    "high-volume payment APIs in Python and Kubernetes.",
                    "rationale": "Targets the role",
                    "keywords": ["Python", "Kubernetes"],
                },
                {
                    "target": "exp1.b0",
                    "proposed": "Owned the checkout service, cutting incidents by 40%",
                    "rationale": "Impact",
                },
                {"target": "exp7.b1", "proposed": "Ghost bullet", "rationale": "Bad target"},
            ],
        )

    def linkedin_writer(self, messages):
        return call(
            "Drafts",
            proposals=[
                {
                    "target": "headline",
                    "proposed": "Senior Backend Engineer · Payments APIs · Python & Kubernetes",
                    "rationale": "Searchable",
                }
            ],
        )

    def critic(self, messages):
        self.critic_rounds += 1
        asked = json.loads(messages[-1].content.split("\n", 1)[1])
        return call("Verdicts", verdicts=[{"proposal_id": p["id"], "ok": True} for p in asked])

    def judge(self, messages):
        return call("Rating", score=4, reason="Clearer and better targeted.")

    def writer_single(self, messages):
        return call(
            "Draft",
            target="ignored",
            proposed="Senior Backend Engineer | Payments",
            rationale="Shorter",
        )


ROLES = {
    "concierge": "You are the assistant of Agentic Resume",
    "intake": "Turn the resume",
    "researcher": "researcher on a team",
    "linkedin_auditor": "Audit the candidate's LinkedIn",
    "gap": "Judge how well this resume fits",
    "resume_writer": "Rewrite parts of the candidate's resume",
    "linkedin_writer": "Write LinkedIn improvements",
    "critic": "You are the critic",
    "judge": "You are a senior recruiter",
}


class StubModel(GenericFakeChatModel):
    """A chat model whose reply comes from a Script, with OpenRouter's usage, and that
    keeps the prompts it was sent."""

    script: Any
    prompts: list[list[BaseMessage]] = []
    messages: Any = iter(())
    disable_streaming: bool = True  # whole replies, tool calls included

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.prompts.append(messages)
        reply = self.script.reply(messages)
        if isinstance(reply, BaseException):
            raise reply
        reply = reply.model_copy(
            update={"id": f"msg-{next(IDS)}", "response_metadata": {"token_usage": USAGE}}
        )
        return ChatResult(
            generations=[ChatGeneration(message=reply)], llm_output={"token_usage": USAGE}
        )


def models(script: Script | None = None) -> Models:
    model = StubModel(script=script or Script())
    return Models(
        concierge=model, intake=model, researcher=model, analyst=model, writer=model, critic=model
    )


def toolbox(fetched: FetchResult | None = None) -> Toolbox:
    @tool
    def web_search(query: str) -> str:
        """Search the web."""
        return "Kafka and Go are in demand for staff backend roles."

    @tool
    def fetch_url(url: str) -> str:
        """Fetch a page."""
        return "Page text"

    async def fetch(url: str) -> FetchResult:
        return fetched or FetchResult(url=url, ok=True, title="Posting", text="Python, Kafka")

    return Toolbox(web_search=web_search, fetch_url=fetch_url, fetch=fetch)


def first_input(linkedin: bool = True, target: TargetJob = TARGET) -> dict:
    """A new session's first input, as the backend builds it."""
    return {
        "documents": {"resume": RESUME, "linkedin": LINKEDIN if linkedin else ""},
        "target": target,
        "messages": [HumanMessage(f"I'm targeting {target.title}.")],
    }
