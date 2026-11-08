"""The code checks behind the 2026-11-08 eval findings: requirement sentences are not
keywords, copy never talks about the posting, and the summary doesn't repeat the bullets."""

import pytest

from agent.nodes.critic import META_ISSUE, deterministic_issues, meta_issues, repetition_issues
from agent.nodes.gap import job_keywords, keyword_terms
from agent.schemas import CandidateProfile, Document, JobAnalysis, Proposal, Report, ReportKind
from agent.tests import stubs


@pytest.mark.parametrize(
    ("term", "keywords"),
    [
        ("2+ years product management experience", []),
        ("Own discovery, prioritization and delivery for a product area", []),
        ("Airflow or Dagster", ["Airflow", "Dagster"]),
        ("React / Vue", ["React", "Vue"]),
        ("Experience with B2B customers", ["B2B customers"]),
        ("CI/CD", ["CI/CD"]),
        ("data-informed decision making", ["data-informed decision making"]),
    ],
)
def test_requirement_sentences_are_not_keywords(term, keywords):
    assert keyword_terms(term) == keywords


def test_job_keywords_split_alternatives_and_drop_duplicates():
    job = JobAnalysis(
        summary="Data role",
        keywords=["Airflow", "Spark"],
        must_have=["Airflow or Dagster", "5+ years of data engineering"],
    )
    reports = {"job": Report(kind=ReportKind.JOB, job=job)}
    assert job_keywords(reports) == ["Airflow", "Spark", "Dagster"]


def proposal(target: str, text: str, document: Document = Document.RESUME) -> Proposal:
    return Proposal(
        id=f"{document.value}:{target}",
        document=document,
        target=target,
        proposed=text,
        rationale="",
    )


@pytest.mark.parametrize(
    "text",
    [
        # The leak the baseline caught, verbatim.
        "Built pipelines in Python, SQL, and Airflow—the Airflow option in the role’s "
        "Airflow or Dagster requirement.",
        "Matches the job description's focus on accessibility.",
        "Covers the requirements of the role with Django experience.",
        "Python and Django, as the posting asks.",
    ],
)
def test_copy_that_talks_about_the_posting_is_flagged(text):
    assert meta_issues(proposal("summary", text)) == [META_ISSUE]


@pytest.mark.parametrize(
    "text",
    [
        "Gathered requirements from clinic staff and turned them into PRDs.",
        "Wrote job descriptions for 20 engineering roles.",
        "I'm looking for a Senior Data Engineer role on a streaming platform team.",
        "Owned the role-based access control for the admin console.",
    ],
)
def test_copy_about_the_candidate_is_not_flagged(text):
    assert meta_issues(proposal("summary", text)) == []


def state(*proposals: Proposal) -> dict:
    profile = CandidateProfile.model_validate(stubs.profile_args())
    for i, role in enumerate(profile.experience):
        role.id = f"exp{i}"
        for j, bullet in enumerate(role.bullets):
            bullet.id = f"exp{i}.b{j}"
    return {
        "profile": profile,
        "proposals": {p.id: p for p in proposals},
        "documents": {"resume": "Built a payments API in Python serving 2 million requests a day"},
        "target": stubs.TARGET,
    }


def test_a_summary_that_copies_a_bullet_is_flagged():
    summary = proposal(
        "summary", "Backend engineer who built a payments API in Python serving many customers."
    )
    [issue] = repetition_issues(summary, state(summary))
    assert "Built a payments API in Python serving 2 million requests a day" in issue


def test_a_summary_that_copies_a_proposed_bullet_is_flagged():
    bullet = proposal("exp0.b1", "Moved twelve services onto Kubernetes with zero downtime")
    summary = proposal("summary", "Engineer who moved twelve services onto Kubernetes with care.")
    assert repetition_issues(summary, state(bullet, summary))


def test_a_summary_in_its_own_words_passes():
    summary = proposal(
        "summary",
        "Backend engineer focused on payment APIs in Python, from design to Kubernetes.",
    )
    assert repetition_issues(summary, state(summary)) == []
    assert deterministic_issues(summary, state(summary)) == []


def test_only_the_resume_summary_is_checked_for_repetition():
    about = proposal(
        "about",
        "I built a payments API in Python serving 2 million requests a day.",
        Document.LINKEDIN,
    )
    assert repetition_issues(about, state(about)) == []


def test_missing_keywords_are_asked_of_one_proposal_not_every_bullet():
    from agent.nodes.critic import keyword_carrier

    bullets = [proposal(f"exp0.b{i}", "text") for i in range(3)]
    skills = proposal("skills", "Python")
    summary = proposal("summary", "Engineer")
    about = proposal("about", "I build things", Document.LINKEDIN)

    def checking(*found):
        return {p.id: p for p in found}

    assert keyword_carrier(checking(*bullets, skills, summary, about)) == "resume:summary"
    assert keyword_carrier(checking(*bullets, skills)) == "resume:skills"
    assert keyword_carrier(checking(*bullets)) == "resume:exp0.b0"
    assert keyword_carrier(checking(about)) is None
