"""The VLM's claims about the picture itself (a frozen camera, a jump cut, a dark or blurred
view) only count when the signal critics saw the same thing: on the camera the claim names,
near the time it names, and never on the wrist camera of an arm that is not doing the task.

The regression behind this file: on a right-arm session the parked left arm's wrist camera
repeats 55 % of its frames (it looks at a still scene), and that alone used to confirm every
freeze claim the model made about the right wrist camera."""

import numpy as np

from lerobot_critics.critics.base import CriticResult
from lerobot_critics.critics.hard.duplication import stall_spans
from lerobot_critics.critics.soft.vlm import VLMJudge

LEFT = "observation.images.wrist_left"
RIGHT = "observation.images.wrist_right"
FRONT = "observation.images.front"


def _right_arm_spec(spec):
    spec = spec.model_copy(deep=True)
    spec.robot.active_arms = ["right"]
    return spec


def _dup(stalls_right=(), stalls_front=(), flags=()):
    """A duplication result like the critic writes it on a right-arm session: the idle left
    camera repeats most of its frames, the working cameras carry their stall spans."""
    return CriticResult(
        id="duplication",
        kind="hard",
        weight=1,
        score=0.9,
        flags=list(flags),
        metrics={
            f"video_dup_rate.{LEFT}": 0.55,
            f"video_dup_rate.{RIGHT}": 0.11,
            f"video_dup_rate.{FRONT}": 0.31,
            f"video_stalls_moving.{RIGHT}": [list(s) for s in stalls_right],
            f"video_stalls_moving.{FRONT}": [list(s) for s in stalls_front],
        },
    )


def _claim(type_="camera_freeze", t=5.2, camera=None, description="the wrist_right camera freezes"):
    a = {"type": type_, "time_s": t, "severity": "major", "description": description}
    if camera:
        a["camera"] = camera
    return {"data": {"indicators": {}, "anomalies": [a], "task_success": True}}


def _verdict(spec, tmp_path, payload, hard):
    summary = VLMJudge(_right_arm_spec(spec), tmp_path).to_results(payload, hard=hard)[-1]
    return summary.flags, summary.metrics["anomalies"][0]


def test_an_idle_camera_full_of_repeats_does_not_confirm_a_claim(spec, tmp_path):
    flags, a = _verdict(spec, tmp_path, _claim(camera="wrist_right"), [_dup()])
    assert "VLM_MAJOR_ANOMALY" not in flags
    assert a["unverified"] is True and a["severity"] == "minor"


def test_a_stall_on_the_named_camera_at_that_time_confirms(spec, tmp_path):
    flags, a = _verdict(spec, tmp_path, _claim(camera="wrist_right"), [_dup(stalls_right=[(4.8, 7.0)])])
    assert "VLM_MAJOR_ANOMALY" in flags
    assert a["severity"] == "major" and not a.get("unverified")
    assert "wrist_right" in a["corroborated_by"]


def test_a_stall_at_another_time_does_not_confirm(spec, tmp_path):
    flags, a = _verdict(spec, tmp_path, _claim(camera="wrist_right"), [_dup(stalls_right=[(1.0, 2.5)])])
    assert "VLM_MAJOR_ANOMALY" not in flags and a["unverified"] is True


def test_a_stall_on_another_camera_does_not_confirm_a_named_claim(spec, tmp_path):
    flags, _ = _verdict(spec, tmp_path, _claim(camera="wrist_right"), [_dup(stalls_front=[(4.8, 7.0)])])
    assert "VLM_MAJOR_ANOMALY" not in flags


def test_the_camera_is_read_from_the_description_when_the_field_is_missing(spec, tmp_path):
    payload = _claim(description="The wrist_right camera feed freezes at t=5.2s")
    assert "VLM_MAJOR_ANOMALY" in _verdict(spec, tmp_path, payload, [_dup(stalls_right=[(5.0, 6.5)])])[0]
    assert "VLM_MAJOR_ANOMALY" not in _verdict(spec, tmp_path, payload, [_dup(stalls_front=[(5.0, 6.5)])])[0]


def test_an_unnamed_claim_takes_any_working_camera(spec, tmp_path):
    payload = _claim(description="the picture freezes")
    assert "VLM_MAJOR_ANOMALY" in _verdict(spec, tmp_path, payload, [_dup(stalls_front=[(5.0, 6.5)])])[0]


def test_a_claim_about_the_idle_arms_camera_never_confirms(spec, tmp_path):
    payload = _claim(camera="wrist_left", description="the wrist_left camera is frozen")
    hard = [_dup(stalls_right=[(4.0, 8.0)], stalls_front=[(4.0, 8.0)], flags=["CAMSTALL"])]
    flags, a = _verdict(spec, tmp_path, payload, hard)
    assert "VLM_MAJOR_ANOMALY" not in flags and a["unverified"] is True


def test_a_jump_cut_is_confirmed_by_a_stall_ending_just_before_it(spec, tmp_path):
    payload = _claim("video_discontinuity", t=5.1, description="the scene jumps")
    assert "VLM_MAJOR_ANOMALY" in _verdict(spec, tmp_path, payload, [_dup(stalls_front=[(4.2, 5.0)])])[0]
    assert "VLM_MAJOR_ANOMALY" not in _verdict(spec, tmp_path, payload, [_dup(stalls_front=[(1.0, 2.0)])])[0]


def test_a_camera_problem_needs_the_image_quality_critic_on_that_camera(spec, tmp_path):
    payload = _claim("camera_problem", camera="wrist_right", description="the wrist_right view is blurred")
    blur_right = CriticResult(
        id="image_quality",
        kind="hard",
        weight=1,
        score=0.3,
        flags=["BLUR"],
        evidence=[f"{RIGHT}: sharpness p10 12"],
    )
    blur_front = blur_right.model_copy(update={"evidence": [f"{FRONT}: sharpness p10 12"]})
    assert "VLM_MAJOR_ANOMALY" in _verdict(spec, tmp_path, payload, [_dup(), blur_right])[0]
    assert "VLM_MAJOR_ANOMALY" not in _verdict(spec, tmp_path, payload, [_dup(), blur_front])[0]


def test_older_runs_without_stall_spans_fall_back_to_camstall(spec, tmp_path):
    old = CriticResult(id="duplication", kind="hard", weight=1, score=0.2, flags=["CAMSTALL"], metrics={})
    assert "VLM_MAJOR_ANOMALY" in _verdict(spec, tmp_path, _claim(), [old])[0]


def test_stall_spans_are_moving_frames_in_seconds_from_the_episode_start():
    dup = np.zeros(100, bool)
    dup[40:60] = True  # 20 frames = 2 s at 10 fps
    dup[70:72] = True  # 0.2 s: too short to report
    moving = np.ones(100, bool)
    moving[50:55] = False  # the robot pauses inside the first stall: the stall is split
    spans = stall_spans(dup, moving, start=10, fps=10.0, min_s=0.5)
    assert spans == [[5.0, 6.0], [6.5, 7.0]]


def test_the_duplication_critic_reports_stall_spans_per_working_camera(synthetic_dataset, spec):
    from lerobot_critics.critics.hard.duplication import DuplicationCritic
    from lerobot_critics.dataset import open_dataset

    ep = open_dataset(synthetic_dataset).episode(0)
    from lerobot_critics.spec.models import HardCriticConfig

    res = DuplicationCritic(spec.hard("duplication") or HardCriticConfig(id="duplication"), spec).evaluate(ep)
    keys = [k for k in res.metrics if k.startswith("video_stalls_moving.")]
    assert sorted(keys) == [f"video_stalls_moving.{c}" for c in sorted(ep.cameras)]
    assert all(isinstance(res.metrics[k], list) for k in keys)


def test_the_model_is_asked_to_name_the_camera_of_a_picture_claim(spec):
    from lerobot_critics.critics.soft.prompts import build_prompt, response_schema

    item = response_schema(spec)["properties"]["anomalies"]["items"]["properties"]
    assert item["camera"]["type"] == "string"
    prompt = build_prompt(spec, [FRONT, RIGHT], FRONT, "layout", 10.0)
    assert "'camera'" in prompt


def test_the_model_is_told_the_composite_sampling_step():
    from lerobot_critics.critics.soft.vlm import _layout_text

    text = _layout_text([FRONT, RIGHT], FRONT, "agentic", src_fps=30, composite_fps=5)
    assert "advances by 6" in text and "not skipped frames" in text
    assert "not a jump cut" in _layout_text([FRONT, RIGHT], FRONT, "frames")


def test_a_camera_field_that_names_no_tile_falls_back_to_the_description(spec, tmp_path):
    payload = _claim(camera="the right wrist", description="the wrist_right camera freezes")
    assert "VLM_MAJOR_ANOMALY" not in _verdict(spec, tmp_path, payload, [_dup(stalls_front=[(5.0, 6.5)])])[0]
    assert "VLM_MAJOR_ANOMALY" in _verdict(spec, tmp_path, payload, [_dup(stalls_right=[(5.0, 6.5)])])[0]
