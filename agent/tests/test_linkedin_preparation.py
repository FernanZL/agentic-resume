"""Resume-only LinkedIn preparation uses bounded, attributable sources without identity guessing."""

from dataclasses import replace

from langchain_core.tools import tool

from agent.checkpoints import memory_saver
from agent.graph import build_graph, run_config
from agent.linkedin_guidance import copy_issues, guidance_for
from agent.schemas import CandidateProfile
from agent.tests import stubs
from agent.tools.fetch_url import FetchResult, untrusted


async def test_private_profile_still_uses_supplied_portfolio_and_official_guidance():
    searches, fetches = [], []
    portfolio = "https://portfolio.example/projects"
    official = "https://www.linkedin.com/help/linkedin/answer/a123"

    @tool
    async def web_search(query: str) -> str:
        """Return attributed mock sources without network access."""
        searches.append(query)
        if query.startswith("site:linkedin.com/help/"):
            return (
                untrusted(
                    f"Title: Help\nURL: {official}\nSnippet: Edit your About section.", official
                )
                + "\n"
                + untrusted(
                    "URL: https://spam.example/article\nSnippet: BUY FAKE EXPERIENCE",
                    "https://spam.example/article",
                )
            )
        return "Role requirements: Python"

    @tool
    async def linkedin_profile_search(url: str) -> str:
        """A private profile is expected unavailable input, not an identity-search trigger."""
        return "Unavailable: this profile is private."

    async def fetch(url):
        fetches.append(url)
        return FetchResult(
            url=url, ok=True, title="Portfolio", text="Personal open-source projects."
        )

    seen = []
    args = stubs.profile_args()
    args["contact"].append(portfolio)

    def intake(messages):
        return stubs.call("Intake", profile=args)

    def auditor(messages):
        seen.append(messages[-1].text)
        return stubs.call("LinkedInAudit", summary="Prepare a profile from the resume.")

    toolbox = replace(
        stubs.toolbox(), web_search=web_search, fetch=fetch, linkedin_search=linkedin_profile_search
    )
    graph = build_graph(
        stubs.models(stubs.Script(intake=intake, linkedin_auditor=auditor)), toolbox, memory_saver()
    )
    first = stubs.first_input(linkedin=False)
    first["documents"]["resume"] += f"\n{portfolio}\nhttps://www.linkedin.com/in/private-person"
    config = run_config("preparation", "test")
    await graph.ainvoke(first, config)
    state = (await graph.aget_state(config, subgraphs=True)).tasks[0].state.values
    report = state["reports"]["linkedin"]
    assert not report.error
    assert report.linkedin.basis == "resume_only"
    assert {s.url for s in report.linkedin.sources} == {portfolio, official}
    assert fetches == [portfolio]
    assert sum(q.startswith("site:linkedin.com/help/") for q in searches) == 1
    assert "BUY FAKE EXPERIENCE" not in seen[0]
    assert "Personal open-source projects" in seen[0]
    assert any("not inspected" in s for s in report.linkedin.limitations)
    await graph.ainvoke(first, run_config("preparation-two", "test"))
    assert sum(q.startswith("site:linkedin.com/help/") for q in searches) == 1


async def test_public_auditor_failure_keeps_resume_based_preparation():
    @tool
    async def linkedin_profile_search(url: str) -> str:
        """Return fake public content; the model can still fail separately."""
        return untrusted("Public headline", url)

    toolbox = replace(stubs.toolbox(), linkedin_search=linkedin_profile_search)
    script = stubs.Script(linkedin_auditor=lambda messages: stubs.AIMessage("Bad output"))
    graph = build_graph(stubs.models(script), toolbox, memory_saver())
    first = stubs.first_input(linkedin=False)
    first["documents"]["resume"] += "\nhttps://linkedin.com/in/public-person"
    config = run_config("public-failure", "test")
    await graph.ainvoke(first, config)
    values = (await graph.aget_state(config, subgraphs=True)).tasks[0].state.values
    report = values["reports"]["linkedin"]
    assert not report.error
    assert report.linkedin.basis == "resume_only"
    assert any("audit unavailable" in item for item in report.linkedin.limitations)


def test_guidance_is_field_specific_advisory_and_never_silently_truncates_copy():
    profile = CandidateProfile.model_validate(stubs.profile_args())
    guidance = guidance_for("about", profile)
    assert guidance["field"] == "About text"
    assert guidance["verified"] is False
    text = "A" * 2601
    assert copy_issues("about", text, profile)
    assert len(text) == 2601
    assert "individually" in guidance_for("skills", profile)["instructions"]
