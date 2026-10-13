"""A spec has a purpose: a recording is judged as training data, an evaluation as a policy
rollout. The purpose sets the defaults (which checks count, what caps a verdict), the
wording of the VLM prompt and the wording of the reports; explicit spec fields win."""

from __future__ import annotations

import json
import time

import pytest
import yaml
from test_visual_report import _ep, _report

from lerobot_critics.critics.soft.prompts import build_prompt, system_role
from lerobot_critics.report import render_markdown
from lerobot_critics.selection import flag_action, selection_lists
from lerobot_critics.spec.models import CriticSpec, load_spec


def _eval_spec(**over) -> CriticSpec:
    return CriticSpec.model_validate(
        {"task": {"instruction": "put the red cup on the tray"}, "purpose": "evaluation", **over}
    )


def test_recording_stays_the_default():
    spec = CriticSpec.model_validate({"task": {"instruction": "stack the cups"}})
    assert spec.purpose == "recording"
    assert spec.hard("tracking_error").weight == 1.5 and spec.hard("tracking_error").gate
    assert "VLM_MAJOR_ANOMALY" in spec.scoring.review_flags
    assert spec.scoring.relative_flags is True


def test_evaluation_defaults_score_the_outcome_only():
    spec = _eval_spec()
    # no hard critic weighs on the score; integrity keeps its gate (a broken file is no rollout)
    assert all(c.weight == 0 for c in spec.hard_critics)
    assert spec.hard("integrity").gate and "VIDEO_MISSING" in spec.hard("integrity").gate_flags
    assert all(not c.gate and not c.gate_flags for c in spec.hard_critics if c.id != "integrity")
    # teleop-only checks are off, the rest still runs for the record (flags, metrics)
    assert not spec.hard("tremor").enabled and not spec.hard("diversity").enabled
    assert spec.hard("tracking_error").enabled and spec.hard("duplication").enabled
    ids = [i.id for i in spec.soft_critics.indicators]
    assert ids == ["object_in_target", "correct_object", "no_disturbance"]
    placed = spec.soft_critics.indicators[0]
    assert placed.gate and placed.gate_below == 0.5 and placed.weight == 3.0 and placed.rubric
    assert spec.scoring.review_flags == ["VLM_TASK_FAILED", "HUMAN_IN_WORKSPACE"]
    assert spec.scoring.relative_flags is False


def test_explicit_fields_win_over_the_purpose_defaults():
    spec = _eval_spec(
        hard_critics=[{"id": "duration", "weight": 1.0}],
        scoring={"review_flags": ["VLM_MAJOR_ANOMALY"], "relative_flags": True},
        soft_critics={"indicators": [{"id": "done", "description": "the cup is on the tray"}]},
    )
    assert [c.id for c in spec.hard_critics] == ["duration"] and spec.hard("duration").weight == 1.0
    assert spec.scoring.review_flags == ["VLM_MAJOR_ANOMALY"] and spec.scoring.relative_flags is True
    assert [i.id for i in spec.soft_critics.indicators] == ["done"]


def test_a_job_purpose_overrides_the_stored_spec(tmp_path):
    p = tmp_path / "s.yaml"
    p.write_text(yaml.safe_dump({"name": "s", "task": {"instruction": "x"}, "purpose": "recording"}))
    spec = load_spec(p, purpose="evaluation")
    assert spec.purpose == "evaluation" and all(c.weight == 0 for c in spec.hard_critics)
    # without a purpose the stored one holds; the round trip keeps it
    assert load_spec(p).purpose == "recording"
    assert CriticSpec.model_validate(json.loads(spec.model_dump_json())).purpose == "evaluation"


def test_the_prompt_frames_a_rollout_as_a_rollout():
    rec = CriticSpec.model_validate({"task": {"instruction": "put the red cup on the tray"}})
    ev = _eval_spec()
    assert "teleoperated" in system_role(rec) and "training" in system_role(rec)
    assert "policy" in system_role(ev) and "training" not in system_role(ev)
    prompt = build_prompt(ev, ["cam"], "cam", "cam", 30.0)
    assert "given to the policy" in prompt and "bad training demonstration" not in prompt
    assert "Judge the outcome" in prompt
    rprompt = build_prompt(rec, ["cam"], "cam", "cam", 30.0)
    assert "given to the operator" in rprompt and "bad training demonstration" in rprompt


def test_the_prompt_tells_the_model_about_the_start_up_delay():
    spec = _eval_spec()
    prompt = build_prompt(spec, ["cam"], "cam", "cam", 30.0, preroll_s=9.8)
    assert "first 9.8 s" in prompt and "normal" in prompt
    assert "first" not in build_prompt(spec, ["cam"], "cam", "cam", 30.0, preroll_s=0.0).split("Scene:")[0]


def test_reports_speak_of_success_and_failure_for_an_evaluation():
    episodes = [
        _ep(0, 0.9, "accept"),
        _ep(1, 0.2, "reject", flags=["VLM_TASK_FAILED"]),
        _ep(2, 0.8, "review"),
    ]
    report = _report(episodes)
    report.spec["purpose"] = "evaluation"
    lists = selection_lists(report)
    assert "success" in lists["accept"]["meaning"] and "training" not in lists["accept"]["meaning"]
    assert "fail" in lists["reject"]["meaning"]
    md = render_markdown(report)
    assert "success" in md and "use for training" not in md and "include + review" not in md
    assert "Why these" in md and "not counted as a success" in md
    rec = _report(episodes)
    assert "use for training" in render_markdown(rec)


def test_flag_advice_depends_on_the_purpose():
    assert "exclude" in flag_action("VLM_TASK_FAILED")
    assert "failure" in flag_action("VLM_TASK_FAILED", "evaluation")
    assert "not charged" in flag_action("CAMSTALL", "evaluation")
    assert "not undo" in flag_action("VLM_MAJOR_ANOMALY", "evaluation")
    # a flag without evaluation-specific advice keeps the general one
    assert flag_action("BLUR", "evaluation") == flag_action("BLUR")


def test_an_evaluation_run_has_no_recording_session_profile(synthetic_dataset, tmp_path):
    from lerobot_critics.runner import RunOptions, run
    from lerobot_critics.spec.models import GripperSpec, RobotSpec, SoftCriticsConfig, TaskSpec, VLMConfig

    spec = CriticSpec(
        name="ev",
        purpose="evaluation",
        task=TaskSpec(instruction="put the red block in the box"),
        robot=RobotSpec(gripper=GripperSpec(feature="observation.state.gripper")),
        soft_critics=SoftCriticsConfig(enabled=True, vlm=VLMConfig(provider="none")),
    )
    report = run(synthetic_dataset, spec, RunOptions(out_dir=str(tmp_path), workers=1, contact_sheets=False))
    assert report.spec["purpose"] == "evaluation"
    assert not report.session_profile.get("indicators")
    # nothing about training statistics or demonstrations is said about rollouts
    assert report.dataset_flags == {}
    # without a judge nothing is decided: every rollout waits for a person
    assert report.counts["review"] == report.n_episodes
    md = (tmp_path / "report.md").read_text()
    assert "Recording session profile" not in md


fastapi = pytest.importorskip("fastapi")


@pytest.fixture
def client(synthetic_dataset, tmp_path, monkeypatch):
    monkeypatch.setenv("CRITICS_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("CRITICS_SPECS_DIR", str(tmp_path / "specs"))
    monkeypatch.setenv("CRITICS_DATA_DIR", str(synthetic_dataset.parent))
    import importlib

    from lerobot_critics.api import app as app_module

    importlib.reload(app_module)
    from fastapi.testclient import TestClient

    return TestClient(app_module.app)


def _wait(client, job_id):
    for _ in range(120):
        st = client.get(f"/jobs/{job_id}").json()
        if st["status"] in ("done", "failed"):
            return st
        time.sleep(0.5)
    return st


def test_a_job_carries_its_purpose_onto_a_stored_and_onto_an_automatic_spec(client, synthetic_dataset):
    assert (
        client.post(
            "/specs", json={"name": "rec", "task": {"instruction": "put the red block in the box"}}
        ).status_code
        == 201
    )
    opts = {"workers": 1, "contact_sheets": False, "run_soft": False, "episodes": [0]}
    r = client.post(
        "/jobs",
        json={"dataset": str(synthetic_dataset), "spec": "rec", "purpose": "evaluation", "options": opts},
    )
    assert r.status_code == 202
    st = _wait(client, r.json()["job_id"])
    assert st["status"] == "done", st
    assert "purpose: evaluation" in client.get(f"/jobs/{r.json()['job_id']}/spec").text
    # the stored spec itself is untouched
    assert client.get("/specs/rec").json()["purpose"] == "recording"

    r = client.post(
        "/jobs",
        json={"dataset": str(synthetic_dataset), "spec": None, "purpose": "evaluation", "options": opts},
    )
    assert r.status_code == 202
    st = _wait(client, r.json()["job_id"])
    assert st["status"] == "done", st
    assert "purpose: evaluation" in client.get(f"/jobs/{r.json()['job_id']}/spec").text
