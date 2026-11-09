"""The wrist camera of an arm that is not doing the task is not shown to the VLM: it looks at a
still scene, carries nothing about the task and reads as a frozen camera."""

import json

from lerobot_critics.critics.soft.providers import VLMResponse
from lerobot_critics.critics.soft.vlm import VLMJudge, ensure_composite, vlm_cameras
from lerobot_critics.dataset import open_dataset
from lerobot_critics.dataset.features import detect_features
from lerobot_critics.dataset.video import probe_video

LEFT = "observation.images.wrist_left"
RIGHT = "observation.images.wrist_right"
FRONT = "observation.images.front"


def _spec(two_arm_spec, arms):
    spec = two_arm_spec(arms)
    spec.soft_critics.enabled = True
    return spec


def test_vlm_cameras_drop_the_idle_wrist(two_arm_dataset, two_arm_spec):
    ds = open_dataset(two_arm_dataset)
    ep = ds.episode(0)
    right = _spec(two_arm_spec, ["right"])
    assert vlm_cameras(ep.cameras, right, detect_features(ds, right, ep)) == [
        c for c in ep.cameras if c != LEFT
    ]
    both = _spec(two_arm_spec, [])
    assert vlm_cameras(ep.cameras, both, detect_features(ds, both, ep)) == list(ep.cameras)


def test_the_composite_leaves_the_idle_wrist_out_and_is_rebuilt_when_that_changes(
    two_arm_dataset, two_arm_spec, tmp_path
):
    ds = open_dataset(two_arm_dataset)
    path = ensure_composite(ds.episode(0), _spec(two_arm_spec, []), tmp_path, fps=5, scale=1.0)
    all_cams = probe_video(path)
    assert json.loads(path.with_suffix(".json").read_text())["cameras"] == [FRONT, LEFT, RIGHT]

    path = ensure_composite(ds.episode(0), _spec(two_arm_spec, ["right"]), tmp_path, fps=5, scale=1.0)
    right_only = probe_video(path)
    assert json.loads(path.with_suffix(".json").read_text())["cameras"] == [FRONT, RIGHT]
    # one tile below the front camera takes the full width, two tiles take half each
    assert right_only.width == all_cams.width and right_only.height > all_cams.height


class _Recorder:
    def __init__(self):
        self.prompt = ""
        self.frames = []

    def judge_frames(self, frames, prompt, schema):
        self.prompt, self.frames = prompt, frames
        data = {"indicators": {}, "anomalies": [], "task_success": True}
        return VLMResponse(data=data, raw_text="", model="fake", usage={}, latency_s=0.0, mode="frames")


def test_the_prompt_and_the_frames_leave_the_idle_wrist_out(two_arm_dataset, two_arm_spec, tmp_path):
    spec = _spec(two_arm_spec, ["right"])
    spec.soft_critics.vlm.cache = False
    judge = VLMJudge(spec, tmp_path)
    rec = _Recorder()
    judge._provider = rec
    ep = open_dataset(two_arm_dataset).episode(0)
    judge.judge(ep)
    assert "wrist_left" not in rec.prompt and "wrist_right" in rec.prompt
    img = rec.frames[0][1]
    assert img.shape[1] == 2 * img.shape[0] * 160 // 120  # front + wrist_right, side by side
