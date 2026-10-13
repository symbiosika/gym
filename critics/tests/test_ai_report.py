"""AI-readable Markdown export: renderer, CLI command, files written by a run."""

from __future__ import annotations

import json

import pytest

from lerobot_critics.ai_report import (
    DETAIL_LEVELS,
    flag_meaning,
    load_report,
    render_ai_markdown,
    render_episode_markdown,
)
from lerobot_critics.critics.base import CriticResult
from lerobot_critics.runner import DatasetReport, EpisodeReport, RunOptions, parse_episodes, run
from lerobot_critics.scoring import EpisodeScore
from lerobot_critics.spec.models import CriticSpec, TaskObject, TaskSpec


def _hard(id, score, flags=(), evidence=(), metrics=None, gate_failed=False, error=None):
    return CriticResult(
        id=id,
        kind="hard",
        weight=1.0,
        score=score,
        gate=gate_failed,
        gate_failed=gate_failed,
        flags=list(flags),
        evidence=list(evidence),
        metrics=metrics or {},
        error=error,
    )


def _fake_report() -> DatasetReport:
    spec = CriticSpec(
        name="cup_tray",
        task=TaskSpec(
            instruction="pick cup from table, place on tray",
            scene="Round table | black tray",
            objects=[TaskObject(name="cup", role="target_object", description="brown cup")],
            expected_cycles=5,
            notes="operator resets the cup",
        ),
    )
    good = EpisodeReport(
        episode=0,
        task="pick cup",
        length=300,
        duration_s=10.0,
        hard=[
            _hard("integrity", 1.0, metrics={"n_frames": 300, "nan_count": 0}),
            _hard("duration", 1.0, metrics={"duration_s": 10.0}),
            _hard("grasp_cycles", 1.0, metrics={"n_cycles": 5, "hold_s": [1.1, 1.2], "swing": 0.8}),
        ],
        soft=[
            CriticResult(
                id="vlm.object_in_target", kind="soft", weight=2.0, score=1.0, evidence=["all placed"]
            ),
            CriticResult(
                id="vlm.summary",
                kind="soft",
                weight=0.0,
                score=1.0,
                metrics={"task_success": True, "confidence": 0.95, "attempts": [], "anomalies": []},
                evidence=["Five clean cycles."],
            ),
        ],
        score=EpisodeScore(episode=0, hard_score=1.0, soft_score=1.0, total=1.0, verdict="accept"),
    )
    bad = EpisodeReport(
        episode=30,
        task="pick cup",
        length=200,
        duration_s=6.7,
        hard=[
            _hard("integrity", 1.0),
            _hard(
                "duplication",
                0.15,
                flags=["CAMSTALL", "LAGGY", "LAGGY_OUTLIER"],
                evidence=["all cameras frozen | for 7.47s", "command vector frozen\nin 22.6% of frames"],
                metrics={"video_dup_rate_max": 0.51, "all_cams_dup_run_s": 7.47, "z.action_dup_rate": 4.2},
                gate_failed=True,
            ),
            _hard("sensor_limits", None, error="RuntimeError: no limits"),
        ],
        soft=[
            CriticResult(
                id="vlm.object_in_target", kind="soft", weight=2.0, score=0.4, flags=["VLM_OBJECT_IN_TARGET"]
            ),
            CriticResult(
                id="vlm.summary",
                kind="soft",
                weight=0.0,
                score=0.0,
                flags=["VLM_TASK_FAILED", "VLM_MAJOR_ANOMALY"],
                metrics={
                    "task_success": False,
                    "confidence": 0.9,
                    "attempts": [
                        {"grasp_time_s": 9.4, "release_time_s": 15.0, "placed_correctly": True},
                        {"grasp_time_s": 20.1, "release_time_s": None, "placed_correctly": False},
                    ],
                    "anomalies": [
                        {"type": "drop", "time_s": 21.5, "severity": "major", "description": "cup | dropped"}
                    ],
                    "model": "gemini-3.7-flash",
                    "mode": "agentic",
                    "usage": {"total_tokens": 34112},
                    "latency_s": 12.3,
                    "cached": True,
                },
                evidence=["Only 2 of 5 cycles.", "drop@21.5s (major): cup dropped"],
            ),
        ],
        score=EpisodeScore(
            episode=30,
            hard_score=0.58,
            soft_score=0.4,
            total=0.49,
            verdict="reject",
            gates_failed=["duplication"],
            flags=[
                "CAMSTALL",
                "LAGGY",
                "LAGGY_OUTLIER",
                "VLM_MAJOR_ANOMALY",
                "VLM_OBJECT_IN_TARGET",
                "VLM_TASK_FAILED",
            ],
            reasons=["all cameras frozen | for 7.47s"],
        ),
    )
    return DatasetReport(
        dataset="/data/ds",
        dataset_name="ds",
        spec_name="cup_tray",
        spec=json.loads(spec.model_dump_json()),
        created_at="2026-09-04T08:00:00+00:00",
        robot_type="humanoid_v1",
        fps=30.0,
        cameras=["cam.front", "cam.wrist"],
        n_episodes=2,
        counts={"accept": 1, "review": 0, "reject": 1},
        include=[0],
        review=[],
        exclude=[30],
        flag_counts={"CAMSTALL": 1, "VLM_TASK_FAILED": 1, "LAGGY_OUTLIER": 1, "VLM_OBJECT_IN_TARGET": 1},
        dataset_stats={
            "duration_s.median": 8.35,
            "duration_s.min": 6.7,
            "duration_s.max": 10.0,
            "camera_dup_rate_median": {"cam.front": 0.36, "cam.wrist": 0.09},
            "vlm_total_tokens": 34112,
        },
        timing_s={"hard_s": 3.0, "soft_s": 12.0, "total_s": 15.5},
        episodes=[good, bad],
    )


def test_full_render_is_self_contained():
    md = render_ai_markdown(_fake_report(), detail="full")
    for heading in (
        "# lerobot-critics report: ds · spec cup_tray",
        "## Run",
        "## Task",
        "## Checks that were run",
        "### Hard critics",
        "### Soft critics",
        "### Scoring rules",
        "## Result",
        "### Flags raised in this run",
        "### Dataset statistics",
        "## Episode scores (worst first)",
        "## Episode details",
        "### Episode 30 — reject (total 0.49)",
        "### Episode 0 — accept (total 1.00)",
    ):
        assert heading in md, heading
    # task, objects and spec facts are stated
    assert "pick cup from table, place on tray" in md and "| cup | target_object | brown cup |" in md
    assert "**accept** if total ≥ 0.75" in md and "**review** if total ≥ 0.55" in md
    assert "`object_in_target`" in md or "`vlm.object_in_target`" in md
    # glossary: every raised flag gets a meaning, including generated ones
    assert "camera frames repeated while the robot moved" in md
    assert "dataset-relative outlier" in md
    assert "VLM indicator 'object_in_target' scored below 0.5" in md
    # worst first, and the reject appears before the accept in the score table
    assert md.index("| 30 | reject |") < md.index("| 0 | accept |")
    # table cells never break: pipes escaped, newlines flattened
    assert "all cameras frozen \\| for 7.47s" in md and "cup \\| dropped" in md
    assert "frozen in 22.6% of frames" in md
    # per-episode content
    assert "GATE FAILED" in md and "error: RuntimeError: no limits" in md
    assert "`duplication`: video_dup_rate_max=0.51, all_cams_dup_run_s=7.47, z.action_dup_rate=4.2" in md
    assert "hold_s=[1.1, 1.2]" in md
    assert "**VLM judge** (gemini-3.7-flash · agentic · 34112 tokens · 12 s · cached)" in md
    assert "| 2 | 20.1 | – | false |" in md and "| drop | 21.5 | major |" in md
    assert "task_success: **False**" in md and "task_success: **True**" in md
    # dataset statistics grouped into median/min/max rows and per-camera columns
    assert "| `duration_s` | 8.35 | 6.7 | 10 |" in md
    assert "| cam.front | 0.36 |" in md
    assert "| `vlm_total_tokens` | 34112 |" in md
    # a Markdown table has the same number of cells in every row
    for block in md.split("\n\n"):
        lines = [ln for ln in block.splitlines() if ln.startswith("|")]
        if lines:
            assert len({ln.replace("\\|", "").count("|") for ln in lines}) == 1, block[:200]


def test_detail_levels_and_episode_filter():
    rep = _fake_report()
    summary = render_ai_markdown(rep, detail="summary")
    flagged = render_ai_markdown(rep, detail="flagged")
    full = render_ai_markdown(rep, detail="full")
    assert "## Episode details" not in summary and "| 30 | reject |" in summary
    assert "### Episode 30" in flagged and "### Episode 0" not in flagged
    assert "(review / reject only)" in flagged
    assert "### Episode 30" in full and "### Episode 0" in full
    assert len(summary) < len(flagged) < len(full)
    only0 = render_ai_markdown(rep, detail="full", episodes=[0])
    assert "| 0 | accept |" in only0 and "| 30 | reject |" not in only0
    assert "### Episode 0" in only0 and "### Episode 30" not in only0
    assert "reject (exclude) | 1 | 30 |" in only0  # the run summary always covers the whole run
    assert "_no episodes selected_" in render_ai_markdown(rep, detail="full", episodes=[99])
    with pytest.raises(ValueError):
        render_ai_markdown(rep, detail="verbose")
    assert set(DETAIL_LEVELS) == {"summary", "flagged", "full"}


def test_episode_markdown():
    rep = _fake_report()
    md = render_episode_markdown(rep, 30)
    assert md.startswith("# lerobot-critics · ds · episode 30")
    assert "Task: pick cup from table, place on tray" in md
    assert "`CAMSTALL` = camera frames repeated while the robot moved" in md
    assert "## Episode 30 — reject (total 0.49)" in md and "**VLM judge**" in md
    assert "### Episode 0" not in md and "Episode 0 —" not in md
    with pytest.raises(KeyError):
        render_episode_markdown(rep, 7)


def test_flag_meaning_fallbacks():
    assert "never closed" in flag_meaning("NOGRASP")
    assert flag_meaning("BLUR_OUTLIER").startswith("dataset-relative outlier")
    assert flag_meaning("VLM_GRASP_CENTERED") == "VLM indicator 'grasp_centered' scored below 0.5"
    assert flag_meaning("SOMETHING_NEW") == "(no description)"


def test_parse_episodes():
    assert parse_episodes(None) is None and parse_episodes("  ") is None
    assert parse_episodes("0,3,7-9") == [0, 3, 7, 8, 9]
    assert parse_episodes(" 2 , 4-4 ,") == [2, 4]
    with pytest.raises(ValueError):
        parse_episodes("a-b")


def test_run_writes_report_ai_and_cli_renders_it(synthetic_dataset, spec, tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from lerobot_critics.cli import app

    out = tmp_path / "out"
    rep = run(
        synthetic_dataset, spec, RunOptions(out_dir=str(out), workers=1, run_soft=False, contact_sheets=False)
    )
    assert (out / "report_ai.md").is_file()
    disk = (out / "report_ai.md").read_text()
    assert disk == render_ai_markdown(rep, detail="full")
    assert "## Episode details" in disk and "### Episode 3" in disk
    assert "put the red block in the box" in disk
    # loadable from the directory or the json file, identical result
    assert load_report(out).model_dump() == load_report(out / "report.json").model_dump()
    with pytest.raises(FileNotFoundError):
        load_report(tmp_path / "nowhere")

    runner = CliRunner()
    r = runner.invoke(app, ["markdown", str(out), "--detail", "flagged", "--episodes", "2,3"])
    assert r.exit_code == 0, r.output
    assert r.output.startswith("# lerobot-critics report") and "(review / reject only)" in r.output
    assert "| 0 | accept |" not in r.output and ("| 2 |" in r.output or "| 3 |" in r.output)
    r = runner.invoke(app, ["markdown", str(out / "report.json"), "--episode", "3"])
    assert r.exit_code == 0 and r.output.startswith("# lerobot-critics · ") and "episode 3" in r.output
    target = tmp_path / "x" / "for_ai.md"
    r = runner.invoke(app, ["markdown", str(out), "-o", str(target), "--detail", "summary"])
    assert r.exit_code == 0 and target.is_file() and "## Episode details" not in target.read_text()
    assert r.output.startswith("wrote ")
    r = runner.invoke(app, ["markdown", str(out), "--detail", "verbose"])
    assert r.exit_code != 0
    r = runner.invoke(app, ["markdown", str(out), "--episode", "42"])
    assert r.exit_code != 0
    r = runner.invoke(app, ["markdown", str(tmp_path / "nowhere")])
    assert r.exit_code != 0
    # --copy: no clipboard tool available -> clear error, nothing printed to stdout
    import shutil

    monkeypatch.setattr(shutil, "which", lambda *_a, **_k: None)
    r = runner.invoke(app, ["markdown", str(out), "--copy"])
    assert r.exit_code == 1 and "no clipboard tool" in r.output and "# lerobot-critics" not in r.output


def test_task_section_lists_per_episode_instructions():
    """A run whose episodes carry different tasks must not be described by one instruction."""
    rep = _fake_report()
    rep.episodes[0].task = "pick the blue cup from the table, place on tray"
    rep.episodes[1].task = "pick the red cup from the table, place on tray"
    md = render_ai_markdown(rep, detail="summary")
    assert "**Instruction**: per episode, from the dataset (2 distinct, below)" in md
    assert "**Spec fallback**: pick cup from table, place on tray" in md
    for t in ("pick the blue cup from the table, place on tray", "pick the red cup"):
        assert t in md
    # and the single-episode view quotes the episode's own task, not the spec's
    assert "Task: pick the red cup from the table, place on tray" in render_episode_markdown(rep, 30)


def test_task_section_keeps_spec_instruction_when_tasks_agree():
    rep = _fake_report()
    md = render_ai_markdown(rep, detail="summary")
    assert "**Instruction**: pick cup from table, place on tray" in md
    assert "per episode, from the dataset" not in md and "Spec fallback" not in md
