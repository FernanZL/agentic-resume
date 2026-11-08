"""Charts of an eval run for the portfolio, in The Score's type and blue (DESIGN.md).

Usage (from the repo root; the web app's node_modules supply the font):
  uv run --with matplotlib --with fonttools --with brotli \\
      python docs/portfolio/evals/make_charts.py RUN.json [--prefix NAME] [--compare BASE.json]

Writes <prefix>scorecard.png and <prefix>coverage.png for RUN, and with --compare a
compare.png of BASE (before) against RUN (after), both scored by the same scorers.
"""

import argparse
import json
import statistics
import sys
import tempfile
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from evals.run import passed  # noqa: E402  the eval's own definition of a passing run
FONT = ROOT / "web/node_modules/@fontsource-variable/hanken-grotesk/files"
SURFACE = "#ffffff"  # sheet
INK = "#121212"  # engraving-black
INK_SOFT = "#3a3d47"
MUTED = "#6b6f7a"
RULE = "#e3e5ea"
BLUE = "#23408e"  # publisher-blue: the one series colour
BLUE_LIGHT = "#9db0dd"  # same hue, lighter step (validated as an ordinal pair)


def load_fonts() -> str:
    """Static instances of the variable Hanken Grotesk (matplotlib can't pick a weight)."""
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont

    src = FONT / "hanken-grotesk-latin-wght-normal.woff2"
    if not src.exists():
        return "DejaVu Sans"
    out = Path(tempfile.mkdtemp())
    for weight in (400, 700, 800):
        font = TTFont(src)
        font.flavor = None
        path = out / f"HankenGrotesk-{weight}.ttf"
        instantiateVariableFont(font, {"wght": weight}, updateFontNames=True).save(path)
        font_manager.fontManager.addfont(path)
    return font_manager.FontProperties(fname=out / "HankenGrotesk-400.ttf").get_name()


def style(family: str) -> None:
    plt.rcParams.update(
        {
            "font.family": family,
            "font.size": 11,
            "text.color": INK,
            "axes.labelcolor": INK_SOFT,
            "axes.edgecolor": RULE,
            "axes.facecolor": SURFACE,
            "figure.facecolor": SURFACE,
            "xtick.color": MUTED,
            "ytick.color": INK,
            "xtick.labelsize": 10,
            "ytick.labelsize": 11,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.spines.left": False,
            "savefig.dpi": 200,
        }
    )


def by_case(rows: list[dict]) -> dict[str, list[dict]]:
    cases: dict[str, list[dict]] = {}
    for row in rows:
        cases.setdefault(row["case"], []).append(row["scores"])
    return dict(sorted(cases.items()))


def heading(fig, title: str, subtitle: str) -> float:
    """Title and subtitle laid out in inches from the top; returns the plot's top edge
    (a figure fraction) so the axes always start below them."""
    height = fig.get_figheight()
    fig.text(0.02, 1 - 0.22 / height, title, fontsize=17, fontweight=800, va="top")
    fig.text(0.02, 1 - 0.62 / height, subtitle, fontsize=11, color=INK_SOFT, va="top",
             linespacing=1.4)
    lines = subtitle.count("\n") + 1
    return 1 - (0.62 + 0.24 * lines + 0.7) / height


def scorecard(cases: dict[str, list[dict]], out: Path, title: str, prefix: str) -> Path:
    """Small multiples, one scale each: every run is a dot, the mean a dark tick."""
    panels = [
        ("evidence_coverage", "Evidence coverage", (0, 1), "{:.0%}"),
        ("faithfulness", "Faithfulness", (0, 1), "{:.0%}"),
        ("tailoring", "Tailoring (1–5)", (1, 5), "{:.1f}"),
    ]
    names = list(cases)
    fig, axes = plt.subplots(1, 3, figsize=(12, 0.55 * len(names) + 2.4), sharey=True)
    runs = max(len(v) for v in cases.values())
    top = heading(
        fig,
        title,
        f"{len(names)} golden cases × {runs} run{'s' if runs > 1 else ''} · dots are runs, the dark tick is the mean",
    )
    for ax, (key, label, (lo, hi), fmt) in zip(axes, panels, strict=True):
        ax.set_title(label, loc="left", fontsize=12, fontweight=700, color=INK, pad=10)
        ax.set_xlim(lo - (hi - lo) * 0.04, hi + (hi - lo) * 0.04)
        ax.grid(axis="x", color=RULE, linewidth=0.8)
        ax.set_axisbelow(True)
        ax.tick_params(axis="y", length=0)
        ticks = [lo + (hi - lo) * i / 4 for i in range(5)] if hi == 1 else range(lo, hi + 1)
        ax.set_xticks(list(ticks))
        ax.set_xticklabels([fmt.format(t) for t in ticks])
        for y, name in enumerate(names):
            values = [s[key] for s in cases[name] if key in s]
            if not values:
                continue
            avg = statistics.fmean(values)
            ax.plot([avg, avg], [y - 0.22, y + 0.22], color=INK, linewidth=2,
                    solid_capstyle="round", zorder=3)
            ax.scatter(values, [y] * len(values), s=64, color=BLUE, alpha=0.6,
                       edgecolors=SURFACE, linewidths=1.5, zorder=4)
            ax.text(1.03, y, fmt.format(avg), va="center", ha="left", fontsize=10,
                    color=INK, fontweight=700, transform=ax.get_yaxis_transform())
    axes[0].set_yticks(range(len(names)))
    axes[0].set_yticklabels(names)
    axes[0].invert_yaxis()
    fig.subplots_adjust(left=0.15, right=0.94, top=top, bottom=0.6 / fig.get_figheight(),
                        wspace=0.28)
    path = out / f"{prefix}scorecard.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def coverage(cases: dict[str, list[dict]], out: Path, prefix: str) -> Path:
    """Raw job-keyword coverage before and after, as a dumbbell per case (means of runs)."""
    names = list(cases)
    fig, ax = plt.subplots(figsize=(10, 0.5 * len(names) + 2.8))
    top = heading(
        fig,
        "Job keywords the resume covers, before and after",
        "Mean of runs. What stays uncovered is mostly skills the candidate doesn't have:\n"
        "the app reports those as gaps instead of inventing them.",
    )
    for y, name in enumerate(names):
        before = statistics.fmean(s["coverage_before"] for s in cases[name])
        after = statistics.fmean(s["coverage_after"] for s in cases[name])
        ax.plot([before, after], [y, y], color=BLUE_LIGHT, linewidth=2, zorder=2)
        ax.scatter([before], [y], s=80, color=BLUE_LIGHT, edgecolors=SURFACE, linewidths=2,
                   zorder=3, label="Before" if y == 0 else None)
        ax.scatter([after], [y], s=80, color=BLUE, edgecolors=SURFACE, linewidths=2,
                   zorder=4, label="After" if y == 0 else None)
        ax.text(min(before, after) - 0.025, y, f"{before:.0%}", va="center", ha="right",
                fontsize=10, color=MUTED)
        ax.text(max(before, after) + 0.025, y, f"{after:.0%}", va="center", ha="left",
                fontsize=10, color=INK, fontweight=700)
    ax.set_yticks(range(len(names)))
    ax.set_yticklabels(names)
    ax.set_ylim(len(names) - 0.5, -0.5)
    ax.set_xlim(0, 1.05)
    ax.set_xticks([0, 0.25, 0.5, 0.75, 1])
    ax.set_xticklabels(["0%", "25%", "50%", "75%", "100%"])
    ax.grid(axis="x", color=RULE, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.tick_params(axis="y", length=0)
    ax.legend(loc="lower right", frameon=False, ncols=2, bbox_to_anchor=(1, 1.0),
              handletextpad=0.3, fontsize=10)
    fig.subplots_adjust(left=0.2, right=0.97, top=top, bottom=0.6 / fig.get_figheight())
    path = out / f"{prefix}coverage.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def avg(scores: list[dict], key: str) -> float:
    """The mean over the runs that have the score (a judge can fail on one run)."""
    return statistics.fmean(s[key] for s in scores if key in s)


def share(scores: list[dict], test) -> float:
    return statistics.fmean(1.0 if test(s) else 0.0 for s in scores)


COMPARED = [
    ("Runs passing every gate", lambda runs: share(runs, passed), (0, 1), "{:.0%}"),
    (
        "Summary in its own words",
        lambda runs: share(runs, lambda s: s.get("summary_original", 1.0) == 1.0),
        (0, 1),
        "{:.0%}",
    ),
    ("Faithfulness", lambda runs: avg(runs, "faithfulness"), (0, 1),
     "{:.0%}"),
    ("Tailoring (1–5)", lambda runs: avg(runs, "tailoring"), (1, 5),
     "{:.1f}"),
]


def compare(before: dict[str, list[dict]], after: dict[str, list[dict]], out: Path) -> Path:
    """Per case and metric, the mean of the runs before and after: a dumbbell, one scale
    per panel."""
    names = [n for n in after if n in before]
    fig, axes = plt.subplots(
        1, len(COMPARED), figsize=(15, 0.55 * len(names) + 2.6), sharey=True
    )
    top = heading(
        fig,
        "Before and after the fixes",
        "Mean of 3 runs per case, both scored by the same checks and judge (v2)",
    )
    for ax, (label, metric, (lo, hi), fmt) in zip(axes, COMPARED, strict=True):
        ax.set_title(label, loc="left", fontsize=12, fontweight=700, color=INK, pad=10)
        span = hi - lo
        ax.set_xlim(lo - span * 0.06, hi + span * 0.06)
        ticks = [lo + span * i / 2 for i in range(3)] if hi == 1 else range(lo, hi + 1, 2)
        ax.set_xticks(list(ticks))
        ax.set_xticklabels([fmt.format(t) for t in ticks])
        ax.grid(axis="x", color=RULE, linewidth=0.8)
        ax.set_axisbelow(True)
        ax.tick_params(axis="y", length=0)
        for y, name in enumerate(names):
            old, new = metric(before[name]), metric(after[name])
            ax.plot([old, new], [y, y], color=BLUE_LIGHT, linewidth=2, zorder=2)
            ax.scatter([old], [y], s=70, color=BLUE_LIGHT, edgecolors=SURFACE, linewidths=2,
                       zorder=3, label="Before" if y == 0 else None)
            ax.scatter([new], [y], s=70, color=BLUE, edgecolors=SURFACE, linewidths=2,
                       zorder=4, label="After" if y == 0 else None)
            ax.text(1.03, y, fmt.format(new), va="center", ha="left", fontsize=10,
                    color=INK, fontweight=700, transform=ax.get_yaxis_transform())
    axes[0].set_yticks(range(len(names)))
    axes[0].set_yticklabels(names)
    axes[0].set_ylim(len(names) - 0.5, -0.5)
    axes[-1].legend(loc="lower right", frameon=False, ncols=2, bbox_to_anchor=(1, 1.12),
                    handletextpad=0.3, fontsize=10)
    fig.subplots_adjust(left=0.12, right=0.95, top=top, bottom=0.6 / fig.get_figheight(),
                        wspace=0.3)
    path = out / "compare.png"
    fig.savefig(path)
    plt.close(fig)
    return path


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="make_charts")
    parser.add_argument("results", type=Path)
    parser.add_argument("--out", type=Path, default=Path(__file__).parent)
    parser.add_argument("--prefix", default="")
    parser.add_argument("--title", default="Baseline: what the rewrites are worth")
    parser.add_argument("--compare", type=Path, help="the earlier run, scored the same way")
    args = parser.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    style(load_fonts())
    cases = by_case(json.loads(args.results.read_text())["results"])
    paths = [scorecard(cases, args.out, args.title, args.prefix),
             coverage(cases, args.out, args.prefix)]
    if args.compare:
        paths.append(compare(by_case(json.loads(args.compare.read_text())["results"]), cases,
                             args.out))
    for path in paths:
        print(path)


if __name__ == "__main__":
    main(sys.argv[1:])
