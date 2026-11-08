"""The eval runner end to end on stub models (the real run needs OPENROUTER_API_KEY)."""

from agent.schemas import CandidateProfile
from agent.tests import stubs
from evals.run import load_case, passes, report, run_case, structure_failures


async def test_a_case_runs_to_a_scored_result(capsys):
    models = stubs.models()
    result = await run_case(load_case("data-engineer"), models, stubs.toolbox(), models.critic)
    assert result["case"] == "data-engineer"
    assert result["proposals"] > 0
    assert 0 <= result["coverage_before"] <= result["coverage_after"] <= 1
    assert result["judge"] == 4
    assert result["cost_usd"] > 0
    assert passes([result])
    report([result])
    assert "data-engineer" in capsys.readouterr().out


def test_quality_gates_fail_for_a_regression_or_case_error():
    assert not passes([{"case": "broken", "error": "did not reach review"}])
    assert not passes([{"checks": {"supported_keywords_covered": False}}])
    assert not passes([])


def test_career_changer_case_catches_missing_projects_and_wrong_kinds():
    case = load_case("career-changer")
    # The old one-profile intake stub must fail this evaluation, even if graph routing passes.
    profile = CandidateProfile.model_validate(stubs.profile_args())
    errors = structure_failures(case, profile)
    assert len(errors) == 3
    assert any("Resume Explorer" in error for error in errors)
