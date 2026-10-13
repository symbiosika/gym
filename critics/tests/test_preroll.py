"""The pre-roll: a leading span where the command is all zero while the robot state is
valid. An evaluation stack records from the start but the policy only takes over a few
seconds in; the critics measure from the first real command and report the delay, instead
of reading the idle start as dropouts, tracking error, frozen commands and a spike."""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from lerobot_critics.critics import build_hard_critics
from lerobot_critics.dataset import open_dataset
from lerobot_critics.dataset.features import detect_features
from lerobot_critics.dataset.preroll import preroll_frames
from lerobot_critics.spec.models import (
    CriticSpec,
    GripperSpec,
    RobotSpec,
    SoftCriticsConfig,
    TaskSpec,
    VLMConfig,
)

LEAD = 15  # frames at 10 fps = 1.5 s


@pytest.fixture(scope="module")
def preroll_dataset(synthetic_dataset, tmp_path_factory) -> Path:
    """The synthetic dataset with episode 0 recorded like an evaluation: the first 1.5 s of
    the arm command are zero rows, the state is what it was."""
    root = tmp_path_factory.mktemp("preroll_ds")
    shutil.copytree(synthetic_dataset, root, dirs_exist_ok=True)
    p = root / "data" / "chunk-000" / "episode_000000.parquet"
    df = pd.read_parquet(p)
    action = np.stack(df["action.arm"].to_numpy())
    action[:LEAD] = 0.0
    df["action.arm"] = list(action.astype(np.float32))
    df.to_parquet(p)
    return root


def _spec(**robot) -> CriticSpec:
    return CriticSpec(
        name="test",
        task=TaskSpec(instruction="put the red block in the box", expected_cycles=1),
        robot=RobotSpec(
            gripper=GripperSpec(feature="observation.state.gripper", closed_is_high=True), **robot
        ),
        soft_critics=SoftCriticsConfig(enabled=True, vlm=VLMConfig(provider="none")),
    )


def _run(ds, spec, ep_index):
    ep = ds.episode(ep_index)
    return {c.id: c.safe_evaluate(ep) for c in build_hard_critics(spec)}


def test_preroll_is_the_leading_zero_command_span(preroll_dataset):
    ds = open_dataset(preroll_dataset)
    spec = _spec()
    ep0, ep1 = ds.episode(0), ds.episode(1)
    assert preroll_frames(ep0, detect_features(ds, spec, ep0), 1.0) == LEAD
    assert preroll_frames(ep1, detect_features(ds, spec, ep1), 1.0) == 0
    # shorter than the minimum it is a dropout, not a start-up delay
    assert preroll_frames(ep0, detect_features(ds, spec, ep0), 2.0) == 0
    assert preroll_frames(ep0, detect_features(ds, spec, ep0), None) == 0


def test_the_critics_measure_from_the_first_real_command(preroll_dataset, synthetic_dataset):
    ds = open_dataset(preroll_dataset)
    res = _run(ds, _spec(), 0)
    clean = _run(open_dataset(synthetic_dataset), _spec(), 0)
    assert all(r.error is None for r in res.values()), {k: r.error for k, r in res.items() if r.error}
    assert "ZERO_FRAMES" not in res["normalization"].flags
    assert res["normalization"].metrics["preroll_frames"] == LEAD
    assert res["normalization"].metrics["preroll_s"] == pytest.approx(1.5)
    assert "TRACKERR" not in res["tracking_error"].flags
    assert res["tracking_error"].metrics["pos_err_mean_mm.action.arm"] == pytest.approx(
        clean["tracking_error"].metrics["pos_err_mean_mm.action.arm"], abs=2.0
    )
    assert "LAGGY" not in res["duplication"].flags
    assert res["duplication"].metrics["action_dup_rate"] < 0.05
    assert "ACTION_SPIKES" not in res["smoothness"].flags
    assert res["smoothness"].metrics["spikes"] == clean["smoothness"].metrics["spikes"]


def test_without_the_detection_the_idle_start_is_read_as_faults(preroll_dataset):
    ds = open_dataset(preroll_dataset)
    res = _run(ds, _spec(preroll_min_s=None), 0)
    assert "ZERO_FRAMES" in res["normalization"].flags
    assert "preroll_frames" not in res["normalization"].metrics
    assert "TRACKERR" in res["tracking_error"].flags
    assert "LAGGY" in res["duplication"].flags
    assert "ACTION_SPIKES" in res["smoothness"].flags


def test_a_single_dropout_frame_stays_a_dropout(synthetic_dataset, tmp_path):
    """One all-zero frame at the start (the cup-tray case) is shorter than any start-up
    delay: it still corrupts the normalisation statistics and is still flagged."""
    root = tmp_path / "ds"
    shutil.copytree(synthetic_dataset, root)
    p = root / "data" / "chunk-000" / "episode_000001.parquet"
    df = pd.read_parquet(p)
    action = np.stack(df["action.arm"].to_numpy())
    action[0] = 0.0
    df["action.arm"] = list(action.astype(np.float32))
    df.to_parquet(p)
    res = _run(open_dataset(root), _spec(), 1)
    assert "ZERO_FRAMES" in res["normalization"].flags
    assert res["normalization"].metrics.get("preroll_frames", 0) == 0


def test_the_run_reports_the_start_up_delay_of_the_session(preroll_dataset, tmp_path):
    from lerobot_critics.runner import RunOptions, run

    report = run(preroll_dataset, _spec(), RunOptions(out_dir=str(tmp_path), workers=1, contact_sheets=False))
    summ = report.dataset_summaries["normalization"]
    assert summ["episodes_with_preroll"] == [0]
    assert summ["preroll_s_max"] == pytest.approx(1.5)
    assert "ZERO_FRAMES" not in report.dataset_flags
    md = (tmp_path / "report.md").read_text()
    assert "preroll" in md


def test_the_camera_of_an_idle_arm_is_not_a_stalled_camera(synthetic_dataset, tmp_path):
    """A wrist camera on the arm that is not doing the task sees a still scene: its repeated
    frames are a fact of the rig, not a stall, once the spec names the active arm."""
    import json

    from conftest import FPS, H, W, _write_video

    root = tmp_path / "ds"
    shutil.copytree(synthetic_dataset, root)
    info = json.loads((root / "meta" / "info.json").read_text())
    still = "observation.images.wrist_right"
    info["features"][still] = dict(info["features"]["observation.images.wrist"])
    (root / "meta" / "info.json").write_text(json.dumps(info))
    for ep in range(4):
        n = json.loads((root / "meta" / "episodes.jsonl").read_text().splitlines()[ep])["length"]
        _write_video(
            root / "videos" / "chunk-000" / still / f"episode_{ep:06d}.mp4",
            [np.full((H, W, 3), 90, np.uint8)] * n,
        )
    assert FPS == 10
    with_all_arms = _run(open_dataset(root), _spec(), 0)
    assert "CAMSTALL" in with_all_arms["duplication"].flags
    left_only = _run(open_dataset(root), _spec(active_arms=["left"]), 0)
    assert "CAMSTALL" not in left_only["duplication"].flags
    # the camera is still measured, it just does not decide
    assert left_only["duplication"].metrics[f"video_dup_rate.{still}"] > 0.9
