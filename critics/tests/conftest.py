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


def _write_video(path: Path, frames: list[np.ndarray]) -> None:
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
        str(FPS),
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


def _episode(n: int, rng: np.random.Generator, broken: bool = False, no_grasp: bool = False):
    t = np.arange(n) / FPS
    # smooth reach-grasp-carry-place trajectory in xyz
    x = 0.3 + 0.2 * np.sin(2 * np.pi * t / (n / FPS))
    y = 0.1 * np.cos(2 * np.pi * t / (n / FPS))
    z = 0.9 + 0.05 * np.sin(4 * np.pi * t / (n / FPS))
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


@pytest.fixture(scope="session")
def synthetic_dataset(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("lerobot_ds")
    rng = np.random.default_rng(0)
    cams = ["observation.images.front", "observation.images.wrist"]
    lengths = [60, 70, 65, 60]
    episodes = []
    for ep, n in enumerate(lengths):
        action, state, grip_a, grip_s = _episode(n, rng, broken=(ep == 2), no_grasp=(ep == 3))
        df = pd.DataFrame(
            {
                "observation.state.arm": list(state),
                "action.arm": list(action),
                "observation.state.gripper": list(grip_s[:, None]),
                "action.gripper": list(grip_a[:, None]),
                "timestamp": (np.arange(n) / FPS).astype(np.float32),
                "frame_index": np.arange(n),
                "episode_index": np.full(n, ep),
                "index": np.arange(n) + sum(lengths[:ep]),
                "task_index": np.zeros(n, int),
            }
        )
        p = root / "data" / "chunk-000" / f"episode_{ep:06d}.parquet"
        p.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(p)
        for ci, cam in enumerate(cams):
            _write_video(
                root / "videos" / "chunk-000" / cam / f"episode_{ep:06d}.mp4",
                _frames(n, grip_s, rng, stalled=(ep == 2), cam=ci),
            )
        episodes.append({"episode_index": ep, "tasks": ["put the red block in the box"], "length": n})
    meta = root / "meta"
    meta.mkdir()
    (meta / "episodes.jsonl").write_text("\n".join(json.dumps(e) for e in episodes) + "\n")
    (meta / "tasks.jsonl").write_text(
        json.dumps({"task_index": 0, "task": "put the red block in the box"}) + "\n"
    )
    feats = {
        "observation.state.arm": {
            "dtype": "float32",
            "shape": [9],
            "names": ["x", "y", "z", "r0", "r1", "r2", "r3", "r4", "r5"],
        },
        "action.arm": {
            "dtype": "float32",
            "shape": [9],
            "names": ["x", "y", "z", "r0", "r1", "r2", "r3", "r4", "r5"],
        },
        "observation.state.gripper": {"dtype": "float32", "shape": [1], "names": ["gripper"]},
        "action.gripper": {"dtype": "float32", "shape": [1], "names": ["gripper"]},
        "timestamp": {"dtype": "float32", "shape": [1]},
        "frame_index": {"dtype": "int64", "shape": [1]},
        "episode_index": {"dtype": "int64", "shape": [1]},
        "index": {"dtype": "int64", "shape": [1]},
        "task_index": {"dtype": "int64", "shape": [1]},
    }
    for cam in cams:
        feats[cam] = {
            "dtype": "video",
            "shape": [H, W, 3],
            "names": ["height", "width", "channels"],
            "video_info": {"video.fps": FPS, "video.codec": "h264"},
        }
    info = {
        "codebase_version": "v2.1",
        "robot_type": "test_bot",
        "total_episodes": len(lengths),
        "total_frames": sum(lengths),
        "total_tasks": 1,
        "fps": FPS,
        "chunks_size": 1000,
        "splits": {"train": f"0:{len(lengths)}"},
        "data_path": "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
        "video_path": "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4",
        "features": feats,
    }
    (meta / "info.json").write_text(json.dumps(info, indent=1))
    return root


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
