"""Synthetic LeRobot v2.1 dataset fixture: 4 short episodes, 2 cameras, one arm with a
cartesian pose + a gripper. Episode 2 is deliberately broken (frozen actions, stalled
camera), episode 3 never grasps."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from lerobot_critics.dataset.video import ffmpeg_exe

FPS = 10
W, H = 160, 120


def _write_video(path: Path, frames: list[np.ndarray], fps: int = FPS) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg_exe(),
        "-y",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{W}x{H}",
        "-r",
        str(fps),
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        "-crf",
        "20",
        str(path),
    ]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()
    assert p.returncode == 0


def _episode(n: int, rng: np.random.Generator, broken: bool = False, no_grasp: bool = False, fps: int = FPS):
    t = np.arange(n) / fps
    # smooth reach-grasp-carry-place trajectory in xyz
    x = 0.3 + 0.2 * np.sin(2 * np.pi * t / (n / fps))
    y = 0.1 * np.cos(2 * np.pi * t / (n / fps))
    z = 0.9 + 0.05 * np.sin(4 * np.pi * t / (n / fps))
    pos = np.stack([x, y, z], 1)
    rot = np.tile(np.array([1, 0, 0, 0, 1, 0], float), (n, 1))
    action = np.concatenate([pos, rot], 1)
    state = action.copy()
    state[2:, :3] = action[:-2, :3]  # 2-frame lag
    state[:, :3] += rng.normal(0, 0.001, (n, 3))
    grip = np.zeros(n)
    if not no_grasp:
        a, b = int(n * 0.3), int(n * 0.7)
        grip[a:b] = 1.0
    grip_s = grip.copy()
    if broken:
        action[n // 2 : n // 2 + n // 4] = action[n // 2]  # frozen command
        state[n // 2 : n // 2 + n // 4] = state[n // 2]
    return (
        action.astype(np.float32),
        state.astype(np.float32),
        grip.astype(np.float32),
        grip_s.astype(np.float32),
    )


def _frames(n: int, grip: np.ndarray, rng: np.random.Generator, stalled: bool = False, cam: int = 0):
    out = []
    for i in range(n):
        img = np.full((H, W, 3), 120 + 40 * cam, np.uint8)
        cx = int(20 + (W - 40) * i / max(n - 1, 1))
        img[40:80, cx - 10 : cx + 10] = (200, 60, 60)  # moving red block
        if grip[i] > 0.5:
            img[90:110, :] = (30, 30, 30)
        img = np.clip(img.astype(int) + rng.integers(-8, 8, img.shape), 0, 255).astype(np.uint8)
        out.append(img)
    if stalled:
        for i in range(n // 2, n // 2 + n // 4):
            out[i] = out[n // 2]
    return out


def _write_dataset(
    root: Path,
    episodes: list[dict[str, np.ndarray]],
    feats: dict,
    cams: list[str],
    robot_type: str,
    rng: np.random.Generator,
    fps: int = FPS,
    task: str = "put the red block in the box",
    stalled: tuple[int, ...] = (),
) -> Path:
    """Write a LeRobot v2.1 dataset. ``episodes`` hold one array per feature name; the key
    ``_grip`` (not a feature) drives the dark bar in the camera frames."""
    lengths = [len(next(v for k, v in ep.items() if k != "_grip")) for ep in episodes]
    meta_eps = []
    for ei, (ep, n) in enumerate(zip(episodes, lengths, strict=True)):
        cols = {k: list(v) for k, v in ep.items() if k != "_grip"}
        df = pd.DataFrame(
            {
                **cols,
                "timestamp": (np.arange(n) / fps).astype(np.float32),
                "frame_index": np.arange(n),
                "episode_index": np.full(n, ei),
                "index": np.arange(n) + sum(lengths[:ei]),
                "task_index": np.zeros(n, int),
            }
        )
        p = root / "data" / "chunk-000" / f"episode_{ei:06d}.parquet"
        p.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(p)
        for ci, cam in enumerate(cams):
            _write_video(
                root / "videos" / "chunk-000" / cam / f"episode_{ei:06d}.mp4",
                _frames(n, ep["_grip"], rng, stalled=(ei in stalled), cam=ci),
                fps,
            )
        meta_eps.append({"episode_index": ei, "tasks": [task], "length": n})
    meta = root / "meta"
    meta.mkdir()
    (meta / "episodes.jsonl").write_text("\n".join(json.dumps(e) for e in meta_eps) + "\n")
    (meta / "tasks.jsonl").write_text(json.dumps({"task_index": 0, "task": task}) + "\n")
    feats = dict(feats)
    feats.update(
        {
            "timestamp": {"dtype": "float32", "shape": [1]},
            "frame_index": {"dtype": "int64", "shape": [1]},
            "episode_index": {"dtype": "int64", "shape": [1]},
            "index": {"dtype": "int64", "shape": [1]},
            "task_index": {"dtype": "int64", "shape": [1]},
        }
    )
    for cam in cams:
        feats[cam] = {
            "dtype": "video",
            "shape": [H, W, 3],
            "names": ["height", "width", "channels"],
            "video_info": {"video.fps": fps, "video.codec": "h264"},
        }
    info = {
        "codebase_version": "v2.1",
        "robot_type": robot_type,
        "total_episodes": len(lengths),
        "total_frames": sum(lengths),
        "total_tasks": 1,
        "fps": fps,
        "chunks_size": 1000,
        "splits": {"train": f"0:{len(lengths)}"},
        "data_path": "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
        "video_path": "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4",
        "features": feats,
    }
    (meta / "info.json").write_text(json.dumps(info, indent=1))
    return root


_POSE9 = ["x", "y", "z", "r0", "r1", "r2", "r3", "r4", "r5"]


@pytest.fixture(scope="session")
def synthetic_dataset(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("lerobot_ds")
    rng = np.random.default_rng(0)
    cams = ["observation.images.front", "observation.images.wrist"]
    lengths = [60, 70, 65, 60]
    episodes = []
    for ep, n in enumerate(lengths):
        action, state, grip_a, grip_s = _episode(n, rng, broken=(ep == 2), no_grasp=(ep == 3))
        episodes.append(
            {
                "observation.state.arm": state,
                "action.arm": action,
                "observation.state.gripper": grip_s[:, None],
                "action.gripper": grip_a[:, None],
                "_grip": grip_s,
            }
        )
    feats = {
        "observation.state.arm": {"dtype": "float32", "shape": [9], "names": _POSE9},
        "action.arm": {"dtype": "float32", "shape": [9], "names": _POSE9},
        "observation.state.gripper": {"dtype": "float32", "shape": [1], "names": ["gripper"]},
        "action.gripper": {"dtype": "float32", "shape": [1], "names": ["gripper"]},
    }
    return _write_dataset(root, episodes, feats, cams, "test_bot", rng, stalled=(2,))


TWO_ARM_FPS = 30  # a tremor at 10 Hz needs a frame rate above 20
TWO_ARM_LENGTH = 300


@pytest.fixture(scope="session")
def two_arm_dataset(tmp_path_factory) -> Path:
    """Two arms and two hands. The right arm does the task and its hand closes at 30 % of the
    episode and stays closed; the left arm is parked (its command offset by 19 cm from the
    state). Episode 4 carries a 1 mm and episode 5 a 5 mm tremor at 10 Hz in the right command."""
    root = tmp_path_factory.mktemp("lerobot_two_arm")
    rng = np.random.default_rng(1)
    cams = ["observation.images.wrist_left", "observation.images.wrist_right", "observation.images.front"]
    n = TWO_ARM_LENGTH
    t = np.arange(n) / TWO_ARM_FPS
    episodes = []
    for ei in range(6):
        action, state, _, _ = _episode(n, rng, fps=TWO_ARM_FPS)
        shift = np.array([-0.08 + 0.04 * ei, 0.03 * (-1) ** ei, 0.0], np.float32)  # the object moves
        action[:, :3] += shift
        state[:, :3] += shift
        if ei in (4, 5):
            amp = 0.001 if ei == 4 else 0.005
            action[:, :3] += amp * np.sin(2 * np.pi * 10.0 * t)[:, None]
        left_state = np.tile(np.array([0.06, 0.43, 0.45, 1, 0, 0, 0, 1, 0], float), (n, 1))
        left_state[:, :3] += rng.normal(0, 0.0005, (n, 3))
        left_action = left_state.copy()
        left_action[:, 0] += 0.19
        hand = np.zeros((n, 4), np.float32)
        hand[int(n * 0.3) :] = 1.0
        episodes.append(
            {
                "action.bot.left_wrist": left_action.astype(np.float32),
                "action.bot.right_wrist": action,
                "observation.state.bot.left_wrist": left_state.astype(np.float32),
                "observation.state.bot.right_wrist": state,
                "action.bot.left_hand": np.zeros((n, 4), np.float32),
                "action.bot.right_hand": hand,
                "observation.state.bot.left_hand": np.zeros((n, 4), np.float32),
                "observation.state.bot.right_hand": hand.copy(),
                "_grip": hand[:, 0],
            }
        )
    finger = ["index", "middle", "ring", "pinky"]
    feats = {}
    for side in ("left", "right"):
        for kind in ("action", "observation.state"):
            feats[f"{kind}.bot.{side}_wrist"] = {"dtype": "float32", "shape": [9], "names": _POSE9}
            feats[f"{kind}.bot.{side}_hand"] = {"dtype": "float32", "shape": [4], "names": finger}
    return _write_dataset(root, episodes, feats, cams, "bot", rng, fps=TWO_ARM_FPS, task="pick the red block")


@pytest.fixture
def two_arm_spec():
    from lerobot_critics.spec.models import (
        CriticSpec,
        RobotSpec,
        SoftCriticsConfig,
        TaskSpec,
        VLMConfig,
    )

    def make(arms: list[str]) -> CriticSpec:
        return CriticSpec(
            name="t",
            task=TaskSpec(instruction="pick"),
            robot=RobotSpec(active_arms=arms),
            soft_critics=SoftCriticsConfig(enabled=False, vlm=VLMConfig(provider="none")),
        )

    return make


@pytest.fixture
def spec():
    from lerobot_critics.spec.models import (
        CriticSpec,
        GripperSpec,
        RobotSpec,
        SoftCriticsConfig,
        TaskSpec,
        VLMConfig,
    )

    return CriticSpec(
        name="test",
        task=TaskSpec(instruction="put the red block in the box", expected_cycles=1),
        robot=RobotSpec(gripper=GripperSpec(feature="observation.state.gripper", closed_is_high=True)),
        soft_critics=SoftCriticsConfig(enabled=True, vlm=VLMConfig(provider="none")),
    )
