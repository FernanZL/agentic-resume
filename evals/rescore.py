"""Score saved eval outputs again with the current scorers: the code checks and the judges
at their current JUDGE_VERSION. The app is not run, so only judge calls are spent. Use it
after changing a judge or a check, so old and new runs are compared by the same scorers.

Usage: uv run --env-file .env python -m evals.rescore evals/results/<run>.json [out.json]
"""

import asyncio
import json
import sys
from pathlib import Path

from evals import judges
from evals.run import (
    Runtime,
    code_checks,
    item_of,
    load_case,
    make_judges,
    real_runtime,
    report,
    row,
)

CONCURRENCY = 6


async def rescore(rows: list[dict], runtime: Runtime) -> list[dict]:
    scorers = make_judges(runtime)
    semaphore = asyncio.Semaphore(CONCURRENCY)

    async def one(saved: dict) -> dict:
        async with semaphore:
            item = item_of(load_case(saved["case"]))
            output = saved["output"]
            evaluations = list(code_checks(output=output, expected_output=item["expected_output"]))
            for scorer in scorers:
                evaluations += await scorer(input=item["input"], output=output)
            return {
                **row(saved["case"], output, evaluations, saved.get("trace_id")),
                "repeat": saved.get("repeat", 1),
            }

    return list(await asyncio.gather(*(one(saved) for saved in rows)))


def main(argv: list[str]) -> None:
    from backend.settings import load

    source = Path(argv[0])
    target = (
        Path(argv[1])
        if len(argv) > 1
        else source.with_name(f"{source.stem}-judge-v{judges.JUDGE_VERSION}.json")
    )
    saved = json.loads(source.read_text())
    rows = asyncio.run(rescore(saved["results"], real_runtime(load())))
    target.write_text(
        json.dumps(
            {
                "rescored_from": str(source),
                "judge_version": judges.JUDGE_VERSION,
                "experiment_urls": saved.get("experiment_urls", []),
                "results": rows,
            },
            indent=2,
            default=str,
        )
    )
    report(rows)
    print(f"\nSaved {target}")


if __name__ == "__main__":
    main(sys.argv[1:])
