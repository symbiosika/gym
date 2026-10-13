"""Visual HTML report: renderer, ranking of the findings, CLI command, file written by a run."""

from __future__ import annotations

import re

from lerobot_critics.critics.base import CriticResult
from lerobot_critics.runner import DatasetReport, EpisodeReport, RunOptions, run
from lerobot_critics.scoring import EpisodeScore
from lerobot_critics.visual_report import (
    _finding_rows,
    _severity_key,
    flag_action,
    render_html_report,
    write_html_report,
)


def _ep(episode: int, total: float, verdict: str, flags=(), gates=(), hard=()) -> EpisodeReport:
    return EpisodeReport(
        episode=episode,
        task="pick the cup",
        length=300,
        duration_s=30.0,
        hard=list(hard),
        soft=[],
        score=EpisodeScore(
            episode=episode,
            hard_score=total,
            soft_score=total,
            total=total,
            verdict=verdict,
            gates_failed=list(gates),
            flags=list(flags),
        ),
    )


def _report(episodes: list[EpisodeReport]) -> DatasetReport:
    counts = {v: sum(1 for e in episodes if e.score.verdict == v) for v in ("accept", "review", "reject")}
    flag_counts: dict[str, int] = {}
    for e in episodes:
        for f in e.score.flags:
            flag_counts[f] = flag_counts.get(f, 0) + 1
    return DatasetReport(
        dataset="/data/ds",
        dataset_name="ds",
        spec_name="cup_tray",
        spec={
            "task": {"instruction": "pick cup from table, place on tray"},
            "hard_critics": [{"id": "duplication", "gate_flags": ["LAGGY"]}],
            "soft_critics": {"indicators": [{"id": "visibility", "description": "cup visible in front cam"}]},
            "scoring": {
                "accept_threshold": 0.75,
                "review_threshold": 0.55,
                "review_flags": ["HUMAN_IN_WORKSPACE"],
            },
        },
        created_at="2026-09-04T08:20:46+00:00",
        robot_type="humanoid_v1",
        fps=30.0,
        cameras=["front", "wrist"],
        n_episodes=len(episodes),
        counts=counts,
        include=[e.episode for e in episodes if e.score.verdict == "accept"],
        review=[e.episode for e in episodes if e.score.verdict == "review"],
        exclude=[e.episode for e in episodes if e.score.verdict == "reject"],
        flag_counts=dict(sorted(flag_counts.items(), key=lambda kv: -kv[1])),
        dataset_flags={"LOW_DIVERSITY": "grasp positions span 1.2 cm over 8 episodes"},
        timing_s={"total_s": 42.0, "hard_s": 40.0, "soft_s": 2.0},
        episodes=episodes,
    )


def _sample() -> DatasetReport:
    dup = CriticResult(
        id="duplication",
        kind="hard",
        weight=1.5,
        score=0.1,
        gate=True,
        gate_failed=True,
        flags=["LAGGY"],
        metrics={"action_dup_rate": 0.42, "_private": 1, "z.dup": 3.1},
        evidence=["command frozen for 9.1 s"],
    )
    vis = CriticResult(id="vlm.visibility", kind="soft", weight=1.0, score=0.2, flags=["VLM_VISIBILITY"])
    eps = [
        _ep(0, 0.95, "accept"),
        _ep(1, 0.92, "accept"),
        _ep(2, 0.80, "review", flags=["HUMAN_IN_WORKSPACE"]),
        _ep(3, 0.60, "review", flags=["HUMAN_IN_WORKSPACE", "JERKY"]),
        _ep(4, 0.58, "review", flags=["VLM_VISIBILITY"]),
        _ep(5, 0.40, "reject", flags=["JERKY"]),
        _ep(6, 0.30, "reject", flags=["LAGGY"], gates=["duplication"], hard=[dup]),
    ]
    eps[4].soft = [vis]
    return _report(eps)


def test_renders_a_self_contained_document():
    html = render_html_report(_sample())
    assert html.startswith("<!doctype html>") and html.rstrip().endswith("</html>")
    # everything inline: no external stylesheet, script or image
    assert "<style>" in html and "https://" not in html and "<link" not in html
    assert html.count("<svg") >= 4  # donut + per-episode + histogram + hbars
    assert "Dataset quality report: ds" in html and "cup_tray" in html
    assert "prints to A4" in html and "@page" in html
    # the headline numbers of the run
    assert "2</b><span>usable for training" in html.replace("\n", "")
    assert "Take <b>2 of 7</b> episodes" in html
    # dataset-level findings and their remedy
    assert "LOW_DIVERSITY" in html and flag_action("LOW_DIVERSITY") in html


def test_detail_analysis_is_bounded_and_worst_first():
    report = _sample()
    # episodes 0 and 1 are clean accepts: nothing to report, so they never get a card
    for top, cards in ((1, 1), (3, 3), (5, 5), (7, 5), (20, 5)):
        assert render_html_report(report, top_n=top).count('class="ep"') == cards
    html = render_html_report(report, top_n=3)
    order = re.findall(r'<span class="num">Episode (\d+)</span>', html)
    assert order == ["6", "5", "4"]  # gate first, then the reject, then the lowest review
    assert "rejected by gate: <b>duplication</b>" in html
    assert "command frozen for 9.1 s" in html
    assert "action_dup_rate=0.42" in html and "_private" not in html and "z.dup" not in html
    # a soft indicator has no evidence of its own: the spec's description explains what was judged
    assert "judged: cup visible in front cam" in html


def test_findings_are_ranked_by_severity_then_frequency():
    report = _sample()
    rows = _finding_rows(report, 4)
    assert [r["flag"] for r in rows] == ["LAGGY", "HUMAN_IN_WORKSPACE", "JERKY", "VLM_VISIBILITY"]
    assert [r["severity"] for r in rows] == ["gate", "review", "info", "info"]
    assert rows[1]["episodes"] == [2, 3]
    assert "teleop link" in rows[0]["action"]
    html = render_html_report(report, top_n=2)
    assert "Top 2 findings of the run" in html and "Flag glossary" in html


def test_severity_key_orders_gate_before_low_score():
    gated = _ep(1, 0.9, "reject", gates=["duplication"])
    low = _ep(2, 0.1, "reject")
    accepted = _ep(3, 0.99, "accept")
    assert sorted([accepted, low, gated], key=_severity_key) == [gated, low, accepted]


def test_says_so_when_nothing_is_conspicuous():
    html = render_html_report(_report([_ep(0, 0.95, "accept"), _ep(1, 0.99, "accept")]))
    assert 'class="ep"' not in html
    assert "No episode was gated, rejected or flagged" in html
    assert "findings of the run" not in html  # no flags at all, so no findings table either


def test_metric_line_drops_zeros_and_duplicates():
    from lerobot_critics.visual_report import _metric_line

    c = CriticResult(
        id="smoothness",
        kind="hard",
        weight=1.0,
        score=0.3,
        metrics={
            "ldj_median.action.arm": -10.65,
            "ldj_median": -10.65,  # aggregate copy of the same number
            "spikes": 0,  # nothing to see
            "hf_ratio": 0.171,
            "_private": 5,
            "z.ldj": 3.0,
            "history": [1, 2, 3],
        },
    )
    line = _metric_line(c)
    assert line == "ldj_median.action.arm=-10.65, hf_ratio=0.171"
    assert _metric_line(c, max_chars=20).endswith(", …")


def test_survives_missing_scores_and_empty_runs():
    ep = EpisodeReport(
        episode=0, length=0, duration_s=0.0, score=EpisodeScore(episode=0, verdict="review"), error="boom"
    )
    html = render_html_report(_report([ep]))
    assert "Episode 0" in html and "<svg" in html
    empty = _report([])
    empty.n_episodes = 0
    html = render_html_report(empty)
    assert "Dataset quality report" in html and 'class="ep"' not in html


def test_run_writes_report_html_and_cli_renders_it(synthetic_dataset, spec, tmp_path):
    from typer.testing import CliRunner

    from lerobot_critics.cli import app

    out = tmp_path / "out"
    run(synthetic_dataset, spec, RunOptions(out_dir=str(out), workers=1, run_soft=False))
    disk = (out / "report.html").read_text()
    assert disk.startswith("<!doctype html>") and "Dataset quality report" in disk
    # the contact sheets of the flagged episodes are embedded, so the file travels on its own
    assert (out / "sheets").is_dir() and "data:image/jpeg;base64," in disk

    runner = CliRunner()
    target = tmp_path / "x" / "visual.html"
    r = runner.invoke(app, ["html", str(out), "-o", str(target), "--top", "2"])
    assert r.exit_code == 0, r.output
    assert target.is_file() and target.read_text().count('class="ep"') == 2
    assert r.output.startswith("wrote ")
    assert runner.invoke(app, ["html", str(tmp_path / "nowhere")]).exit_code != 0
    # writing into the run directory is what a run itself does
    assert write_html_report(_sample(), tmp_path) == tmp_path / "report.html"
    assert (tmp_path / "report.html").is_file()
