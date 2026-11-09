"""Scoring a finished run against episodes a person labelled: how many of the rejects were
right, how many of the bad episodes were caught, and what every flag is worth."""

import json

from typer.testing import CliRunner

from lerobot_critics.benchmark import compare, load_labels, render_text
from lerobot_critics.cli import app
from lerobot_critics.critics.base import CriticResult
from lerobot_critics.runner import DatasetReport, EpisodeReport
from lerobot_critics.scoring import EpisodeScore


def _ep(i, verdict, flags=()):
    hard = [CriticResult(id="x", kind="hard", weight=1, score=1.0, flags=list(flags))]
    return EpisodeReport(
        episode=i, hard=hard, score=EpisodeScore(episode=i, verdict=verdict, flags=list(flags))
    )


def _report(rows):
    return DatasetReport(
        dataset="d",
        dataset_name="d",
        spec_name="s",
        spec={"task": {"instruction": "pick"}},
        created_at="now",
        episodes=[_ep(*r) for r in rows],
    )


PROVENANCE = {
    "source_to_new_episode_index": {"0": 0, "1": 1, "4": 2},
    "excluded": {"2": ["TREMOR"], "3": ["TREMOR", "LAG_BAD_300ms"], "5": ["VLM_DROP_CONFIRMED"]},
}


def test_labels_from_a_subset_provenance(tmp_path):
    p = tmp_path / "subset_provenance.json"
    p.write_text(json.dumps(PROVENANCE))
    labels = load_labels(p)
    assert labels.bad == {2: ["TREMOR"], 3: ["TREMOR", "LAG_BAD_300ms"], 5: ["VLM_DROP_CONFIRMED"]}
    assert labels.good == {0, 1, 4}


def test_labels_from_a_plain_exclude_list(tmp_path):
    p = tmp_path / "labels.json"
    p.write_text(json.dumps({"exclude": [2, 3], "include": [0, 1]}))
    labels = load_labels(p)
    assert set(labels.bad) == {2, 3} and labels.good == {0, 1}
    # without an include list every other episode of the run counts as good
    p.write_text(json.dumps({"exclude": {"2": ["TREMOR"]}}))
    labels = load_labels(p)
    assert labels.bad == {2: ["TREMOR"]} and labels.good is None


def test_compare_counts_verdicts_flags_and_reasons(tmp_path):
    p = tmp_path / "subset_provenance.json"
    p.write_text(json.dumps(PROVENANCE))
    report = _report(
        [
            (0, "accept"),
            (1, "reject", ["VLM_TASK_FAILED"]),  # a good episode rejected
            (2, "reject", ["TREMOR"]),
            (3, "reject", ["TREMOR", "VLM_TASK_FAILED"]),
            (4, "review", ["VLM_TASK_FAILED"]),
            (5, "accept"),  # a bad episode let through
            (6, "accept"),  # not labelled: left out
        ]
    )
    res = compare(report, load_labels(p))
    assert res["n"] == 6 and res["unlabelled"] == [6]
    assert res["confusion"] == {
        "accept": {"bad": 1, "good": 1},
        "review": {"bad": 0, "good": 1},
        "reject": {"bad": 2, "good": 1},
    }
    assert res["reject"] == {"precision": 2 / 3, "recall": 2 / 3, "tp": 2, "fp": 1, "fn": 1}
    assert res["filtered"]["precision"] == 2 / 4 and res["filtered"]["recall"] == 2 / 3
    flags = {f["flag"]: f for f in res["flags"]}
    assert flags["TREMOR"] == {"flag": "TREMOR", "on_bad": 2, "on_good": 0, "precision": 1.0, "recall": 2 / 3}
    assert flags["VLM_TASK_FAILED"]["on_good"] == 2 and flags["VLM_TASK_FAILED"]["precision"] == 1 / 3
    reasons = {r["reason"]: r for r in res["reasons"]}
    assert reasons["TREMOR"] == {"reason": "TREMOR", "n": 2, "reject": 2, "review": 0, "accept": 0}
    assert reasons["VLM_DROP_CONFIRMED"]["accept"] == 1
    assert res["good_rejected"] == [1] and res["bad_accepted"] == [5]
    text = render_text(res)
    assert "reject precision" in text and "TREMOR" in text and "VLM_DROP_CONFIRMED" in text


def test_the_eval_command_on_a_finished_run(synthetic_dataset, spec, tmp_path):
    from lerobot_critics.runner import RunOptions, run

    out = tmp_path / "out"
    run(synthetic_dataset, spec, RunOptions(out_dir=str(out), workers=1, run_soft=False))
    labels = tmp_path / "labels.json"
    labels.write_text(json.dumps({"exclude": [2, 3]}))
    res = CliRunner().invoke(app, ["eval", str(out), "--labels", str(labels)])
    assert res.exit_code == 0, res.output
    assert "reject precision" in res.output
    res = CliRunner().invoke(app, ["eval", str(out), "--labels", str(labels), "--json"])
    assert res.exit_code == 0 and json.loads(res.output)["n"] == 4
