"""The eval runner end to end on stub models (the real run needs OPENROUTER_API_KEY)."""

from types import SimpleNamespace

from langchain_core.messages import AIMessage, SystemMessage
from langfuse import Evaluation

from agent.schemas import CandidateProfile
from agent.tests import stubs
from evals import judges
from evals.run import (
    Runtime,
    case_names,
    code_checks,
    item_of,
    load_case,
    make_judges,
    make_task,
    passes,
    report,
    run_local,
    structure_failures,
    summary,
    sync_dataset,
)


def stub_runtime(script: stubs.Script | None = None) -> Runtime:
    models = stubs.models(script)
    return Runtime(
        models=lambda: models, toolbox=lambda client: stubs.toolbox(), judge=lambda: models.critic
    )


def evaluators(runtime: Runtime) -> list:
    return [code_checks, *make_judges(runtime)]


async def test_a_case_runs_to_scored_rows(capsys):
    runtime = stub_runtime()
    item = item_of(load_case("data-engineer"))
    [row] = await run_local([item], make_task(runtime), evaluators(runtime))
    scores = row["scores"]
    assert row["case"] == "data-engineer"
    assert scores["completed"] == 1.0
    assert scores["proposals"] > 0
    assert 0 <= scores["coverage_before"] <= scores["coverage_after"] <= 1
    assert scores["faithfulness"] == 1.0
    assert scores["tailoring"] == 4
    assert scores["cost_usd"] > 0
    assert passes([row])
    report([row, {**row, "scores": {**scores, "tailoring": 2}}])
    out = capsys.readouterr().out
    assert "data-engineer" in out
    assert "3.0±1.0" in out  # two runs, tailoring 4 and 2


async def test_a_failing_case_is_an_unpassed_result_not_a_crash():
    script = stubs.Script(intake=lambda messages: RuntimeError("provider down"))
    runtime = stub_runtime(script)
    [row] = await run_local(
        [item_of(load_case("data-engineer"))], make_task(runtime), evaluators(runtime)
    )
    assert row["scores"] == {"completed": 0.0}
    assert not passes([row])


def test_quality_gates_fail_for_a_regression_or_no_results():
    assert not passes([{"scores": {"completed": 1.0, "supported_keywords_covered": 0.0}}])
    assert not passes([])
    assert passes([{"scores": {"completed": 1.0, "tailoring": 1}}])  # judges never gate


def output(after: str, proposed: str = "", unsafe: str = "") -> dict:
    return {
        "before": "Python developer",
        "after": after,
        "proposals": [
            {"id": "resume:summary", "proposed": proposed, "status": "ok"}
            | {"unsupported_numbers": []}
        ],
        "entries": [],
        "keywords": {"job": ["Python", "Kafka"], "supportable": ["Python"]},
        "unsafe": unsafe,
        "cost_usd": 0.01,
        "seconds": 1.0,
    }


def scored(found: list[Evaluation]) -> dict:
    return {e.name: e.value for e in found}


def test_planted_claims_and_an_unflagged_injection_fail_their_gates():
    expected = {"forbidden_output_terms": ["Google", "PhD"], "expect_injection_flag": True}
    obeyed = scored(
        code_checks(output=output("Python developer, ex-Google"), expected_output=expected)
    )
    assert obeyed["no_planted_claims"] == 0.0
    assert obeyed["injection_flagged"] == 0.0
    resisted = scored(
        code_checks(
            output=output("Python developer", unsafe="hidden instructions"),
            expected_output=expected,
        )
    )
    assert resisted["no_planted_claims"] == resisted["injection_flagged"] == 1.0


def test_evidence_coverage_counts_only_what_the_candidate_can_claim():
    scores = scored(code_checks(output=output("Python developer"), expected_output={}))
    assert scores["evidence_coverage"] == 1.0  # Kafka is not supportable
    assert scores["coverage_after"] == 0.5
    lost = scored(code_checks(output=output("A developer"), expected_output={}))
    assert lost["coverage_not_regressed"] == lost["supported_keywords_covered"] == 0.0


def test_career_changer_case_catches_missing_projects_and_wrong_kinds():
    expected = item_of(load_case("career-changer"))["expected_output"]
    # The old one-profile intake stub must fail this evaluation, even if graph routing passes.
    profile = CandidateProfile.model_validate(stubs.profile_args())
    entries = [
        {"title": r.title, "kind": r.kind, "source_section": r.source_section, "text": ""}
        for r in profile.experience
    ]
    errors = structure_failures(expected, entries)
    assert len(errors) == 3
    assert any("Resume Explorer" in error for error in errors)


async def test_a_proposal_the_judge_skips_is_unchecked_not_faithful():
    def judge(messages):
        return stubs.call(
            "Faithfulness",
            checks=[{"proposal_id": "a", "unsupported": ["led a team of 40"]}],
        )

    runtime = stub_runtime(stubs.Script(faithfulness=judge))
    faithfulness, _ = make_judges(runtime)
    proposals = [{"id": pid, "original": "", "proposed": "x", "status": "ok"} for pid in ("a", "b")]
    [found] = await faithfulness(input={"resume": "r"}, output={"proposals": proposals})
    assert found.value == 0.0  # the only checked proposal has an unsupported claim
    assert "led a team of 40" in found.comment
    assert "1 proposals not checked" in found.comment


def test_judges_see_the_submitted_documents_not_the_parsed_profile():
    text = judges.source_documents({"resume": "RAW RESUME", "linkedin": "RAW PROFILE"})
    assert "RAW RESUME" in text
    assert "RAW PROFILE" in text


def test_the_run_summary_reports_the_gate_pass_rate_and_judge_means():
    def result(completed: float, tailoring: int):
        return SimpleNamespace(
            evaluations=[
                Evaluation(name="completed", value=completed),
                Evaluation(name="tailoring", value=tailoring),
            ]
        )

    found = {e.name: e.value for e in summary(item_results=[result(1.0, 4), result(0.0, 2)])}
    assert found == {"gates_pass_rate": 0.5, "mean_tailoring": 3.0}


class FakeLangfuse:
    """The dataset calls the runner makes, kept in memory."""

    def __init__(self, items: list[dict] | None = None):
        self.items = {i["id"]: SimpleNamespace(**i) for i in items or []}
        self.created: list[str] = []
        self.exists = items is not None

    def get_dataset(self, name):
        if not self.exists:
            from langfuse.api import NotFoundError

            raise NotFoundError(body="missing")
        return SimpleNamespace(items=list(self.items.values()))

    def create_dataset(self, **kwargs):
        self.exists = True

    def create_dataset_item(self, *, dataset_name, **item):
        self.created.append(item["id"])
        self.items[item["id"]] = SimpleNamespace(**item)


def test_the_dataset_follows_the_case_files_and_skips_unchanged_items():
    items = [item_of(load_case(name)) for name in case_names([])]
    client = FakeLangfuse()
    synced = sync_dataset(client, items)
    assert {i.id for i in synced} == {i["id"] for i in items}
    assert len(client.created) == len(items)

    edited = [{**items[0], "metadata": {**items[0]["metadata"], "note": "edited"}}, *items[1:]]
    client.created.clear()
    synced = sync_dataset(client, edited[:2])
    assert client.created == [edited[0]["id"]]  # only the edited case is written again
    assert [i.id for i in synced] == [i["id"] for i in edited[:2]]


def test_every_case_file_is_a_valid_item():
    for name in case_names([]):
        item = item_of(load_case(name))
        assert item["id"] == f"golden-{name}"
        assert item["input"]["resume"]
        assert item["input"]["target"]["title"]
        assert item["metadata"]["case"] == name


def test_the_stub_judges_answer_the_judge_prompts():
    reply = stubs.Script().reply
    assert isinstance(reply([SystemMessage(judges.TAILORING)]), AIMessage)


def test_meta_commentary_fails_its_gate_and_a_copied_summary_is_measured():
    leak = "Airflow, the Airflow option in the role's Airflow or Dagster requirement"
    after = (
        "# Sam\n\n## Summary\nEngineer who built daily ETL jobs in Python and Airflow moving data."
        "\n\n## Experience\n- Built daily ETL jobs in Python and Airflow moving shipment data\n"
    )
    found = scored(code_checks(output=output(after, proposed=leak), expected_output={}))
    assert found["no_meta_commentary"] == 0.0
    assert found["summary_original"] == 0.0
    assert not passes([{"scores": found}])  # meta gates, the summary measure doesn't
    clean = scored(
        code_checks(
            output=output(
                after.replace(
                    "Engineer who built daily ETL jobs in Python and Airflow moving data.",
                    "Data engineer focused on reliable batch pipelines.",
                )
            ),
            expected_output={},
        )
    )
    assert clean["no_meta_commentary"] == clean["summary_original"] == 1.0


async def test_saved_outputs_are_rescored_with_the_current_scorers():
    from evals.rescore import rescore

    runtime = stub_runtime()
    [first] = await run_local(
        [item_of(load_case("data-engineer"))], make_task(runtime), evaluators(runtime)
    )
    [again] = await rescore([{**first, "repeat": 2}], runtime)
    assert again["repeat"] == 2
    assert again["output"] == first["output"]
    assert again["scores"] == first["scores"]


async def test_a_judge_that_answers_in_prose_once_is_asked_again():
    answers = iter([AIMessage(content="It looks good to me."), None])

    def tailoring(messages):
        reply = next(answers)
        return reply or stubs.call("Tailoring", score=3, reason="Fine.")

    runtime = stub_runtime(stubs.Script(tailoring=tailoring))
    rating = await judges.tailoring(runtime.judge(), {}, "before", "after")
    assert rating.score == 3
