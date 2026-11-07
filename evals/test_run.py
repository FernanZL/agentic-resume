"""The eval runner end to end on stub models (the real run needs OPENROUTER_API_KEY)."""

from agent.tests import stubs
from evals.run import load_case, report, run_case


async def test_a_case_runs_to_a_scored_result(capsys):
    models = stubs.models()
    result = await run_case(load_case("data-engineer"), models, stubs.toolbox(), models.critic)
    assert result["case"] == "data-engineer"
    assert result["proposals"] > 0
    assert 0 <= result["coverage_before"] <= result["coverage_after"] <= 1
    assert result["judge"] == 4
    assert result["cost_usd"] > 0
    report([result])
    assert "data-engineer" in capsys.readouterr().out
