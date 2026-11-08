"""Mixed career histories retain section fidelity and old pending reviews remain usable."""

import base64
import io
import json
from pathlib import Path

import docx
from langgraph.types import Command

from agent.checkpoints import memory_saver
from agent.graph import build_graph, run_config
from agent.nodes.critic import attribution_issues
from agent.nodes.review import resume_with
from agent.render import apply_decisions, assign_ids, original_of, profile_markdown
from agent.schemas import (
    CandidateProfile,
    Decision,
    Document,
    Experience,
    LinkedInProfile,
    Proposal,
)
from agent.sections import validate_sections
from agent.tests import stubs
from agent.tools.ats import format_issues
from backend.export import docx_bytes, html_page, markdown


def mixed_profile():
    """A career changer with undated projects and a real unrelated earlier career."""
    profile = CandidateProfile(
        name="Jordan Example",
        contact=["jordan@example.com"],
        summary="Engineer and former teacher.",
        skills=["Python"],
        certifications=["Cloud foundations"],
        languages=["English"],
        other=["Volunteer award"],
        experience=[
            Experience(
                id="",
                title="Software Engineer",
                organization="Acme",
                kind="employment",
                source_section="Professional Experience",
                start="2024",
                end="Present",
            ),
            Experience(
                id="",
                title="Open-source Resume Tool",
                kind="project",
                source_section="Personal Projects",
                bullets=[{"id": "", "text": "Built a Python API."}],
            ),
            Experience(
                id="",
                title="Teacher",
                organization="Local School",
                kind="employment",
                source_section="Earlier Career",
                start="2017",
                end="2023",
            ),
        ],
    )
    assign_ids(profile, None)
    return profile


def test_sections_and_all_retained_content_agree_across_exports():
    profile = mixed_profile()
    final = apply_decisions(profile, None, {}, {})
    markdown = profile_markdown(profile)
    html = html_page(final)
    document = docx.Document(io.BytesIO(docx_bytes(profile)))
    paragraphs = "\n".join(p.text for p in document.paragraphs)
    for content in (markdown, html, paragraphs):
        assert (
            content.index("Professional Experience")
            < content.index("Personal Projects")
            < content.index("Earlier Career")
        )
        assert "Cloud foundations" in content
        assert "English" in content
        assert "Volunteer award" in content
        assert "Local School" in content
    assert [r.id for r in profile.experience] == ["exp0", "exp1", "exp2"]
    assert not any("exp1" in issue and "dates" in issue for issue in format_issues(profile))


def test_source_headings_are_checked_without_guessing_legacy_classifications():
    profile = mixed_profile()
    warnings = validate_sections(
        profile, "Professional Experience\nPersonal Projects\nEarlier Career"
    )
    assert warnings == []
    profile.experience[1].source_section = "Made Up By Model"
    assert validate_sections(profile, "Professional Experience\nPersonal Projects\nEarlier Career")
    assert profile.experience[1].source_section == ""
    assert "## Projects" in profile_markdown(profile)
    legacy = Experience(id="exp8", title="Unknown source", organization="")
    assert legacy.kind == "unclassified"


def test_attribution_check_prevents_project_facts_becoming_employment_claims():
    profile = mixed_profile()
    proposal = Proposal(
        id="resume:new:exp0",
        document=Document.RESUME,
        target="new:exp0",
        proposed="Built the resume tool at Acme.",
        rationale="Wrong attribution",
        evidence_refs=["exp1"],
    )
    assert attribution_issues(proposal, {"profile": profile})


def unpack(value):
    """Restore the portable JSON fixture generated with the actual pre-change serializer."""
    if isinstance(value, list):
        return [unpack(v) for v in value]
    if not isinstance(value, dict):
        return value
    if "bytes" in value:
        return base64.b64decode(value["bytes"])
    if "tuple" in value:
        return tuple(unpack(v) for v in value["tuple"])
    return {unpack(k): unpack(v) for k, v in value["mapping"]}


async def test_real_old_serialized_checkpoint_loads_and_its_review_resumes():
    fixture = json.loads((Path(__file__).parent / "fixtures/legacy_review.json").read_text())
    saver = memory_saver()
    for thread, namespaces in unpack(fixture["storage"]).items():
        saver.storage[thread].update(namespaces)
    saver.blobs.update(unpack(fixture["blobs"]))
    saver.writes.update(unpack(fixture["writes"]))
    graph = build_graph(stubs.models(), stubs.toolbox(), saver)
    config = run_config("legacy", "compatibility")
    state = await graph.aget_state(config, subgraphs=True)
    assert state.interrupts
    profile = state.tasks[0].state.values["profile"]
    assert all(r.kind == "unclassified" and r.source_section == "" for r in profile.experience)
    assert [r.id for r in profile.experience] == ["exp0", "exp1"]
    before = profile_markdown(profile)
    assert "## Experience" in before
    assert "## Projects" not in before
    await graph.ainvoke(
        Command(
            resume=resume_with(
                {
                    "resume:summary": {"action": "accept"},
                    "resume:exp1.b0": {"action": "edit", "text": "Reviewed checkout ownership."},
                }
            )
        ),
        config,
    )
    finished = (await graph.aget_state(config)).values
    assert finished["analyzed"]
    assert profile_markdown(finished["profile"]) == before
    decided = apply_decisions(profile, None, finished["proposals"], finished["decisions"])
    assert decided.resume.summary == finished["proposals"]["resume:summary"].proposed
    assert decided.resume.experience[1].bullets[0].text == "Reviewed checkout ownership."
    assert decided.resume.experience[0].bullets[0].text == profile.experience[0].bullets[0].text


def test_list_edits_preserve_commas_inside_certifications_and_other_items():
    profile = mixed_profile()
    profile.other = ["Speaker, PyCon 2024", "Volunteer award, Lisbon"]
    original = original_of("other", Document.RESUME, profile, None)
    assert original == "Speaker, PyCon 2024\nVolunteer award, Lisbon"
    proposal = Proposal(
        id="resume:other",
        document=Document.RESUME,
        target="other",
        original=original,
        proposed="Speaker, PyCon 2024\nCommunity award, Lisbon",
        rationale="Edit",
    )
    final = apply_decisions(
        profile, None, {proposal.id: proposal}, {proposal.id: Decision(action="accept")}
    )
    assert final.resume.other == ["Speaker, PyCon 2024", "Community award, Lisbon"]


def test_linkedin_copy_exports_use_named_entries_and_skills_labels():
    profile = mixed_profile()
    linkedin = LinkedInProfile(
        experience=[Experience(id="li0", title="Mentor", organization="Community")]
    )
    proposals = {
        "linkedin:exp1": Proposal(
            id="linkedin:exp1",
            document=Document.LINKEDIN,
            target="exp1",
            proposed="Built a personal project.",
            rationale="Project evidence",
        ),
        "linkedin:li0": Proposal(
            id="linkedin:li0",
            document=Document.LINKEDIN,
            target="li0",
            proposed="Mentored contributors.",
            rationale="Clarify",
        ),
        "linkedin:skills": Proposal(
            id="linkedin:skills",
            document=Document.LINKEDIN,
            target="skills",
            proposed="Python",
            rationale="Supported",
        ),
    }
    final = apply_decisions(
        profile, linkedin, proposals, {pid: Decision(action="accept") for pid in proposals}
    )
    for content in (markdown(final), html_page(final)):
        assert "Open-source Resume Tool" in content
        assert "Mentor" in content
        assert "Community" in content
        assert "Skills" in content
        assert "Experience (exp" not in content
        assert "Experience (li" not in content
