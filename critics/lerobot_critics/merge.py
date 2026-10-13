"""Merge selected episodes of several LeRobot datasets into one.

What comes out of a gym session is N uploads, each analysed on its own, and a
selection of episodes spread over them. That selection is what should be
trained on, so it has to become *one* dataset: episodes renumbered without
gaps, one task table, one ``meta/info.json``.

The output is always the v2.1 layout (one parquet and one video file per
episode), because it is the one every LeRobot version reads. Sources may be
v2.x or v3.0 packed; the loader hides the difference, and a packed video file
is cut to the episode's window.

Only episodes that actually fit together are merged: same fps and the same
feature set. A mismatch is an error with the two values in it, never a silent
reinterpretation of somebody's training data.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .dataset.loader import LeRobotDataset, open_dataset
from .dataset.video import ffmpeg_exe

DATA_PATH = "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet"
VIDEO_PATH = "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4"
CHUNK_SIZE = 1000


class MergeError(RuntimeError):
    """The sources do not fit together, or an episode is not there."""


@dataclass
class MergeSource:
    """One source dataset and the episodes of it that were selected."""

    root: Path
    episodes: list[int]
    #: what to call it in the manifest; defaults to the directory name
    name: str = ""

    def __post_init__(self) -> None:
        self.root = Path(self.root)
        self.name = self.name or self.root.name


@dataclass
class MergedEpisode:
    """Where one episode of the merged dataset came from."""

    index: int
    source: str
    source_episode: int
    length: int
    task: str


@dataclass
class MergeResult:
    root: Path
    episodes: list[MergedEpisode]
    frames: int
    tasks: list[str]
    cameras: list[str]
    fps: float
    robot_type: str
    #: what could not be carried over, in plain words
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Compatibility
# ---------------------------------------------------------------------------


def _feature_signature(ds: LeRobotDataset) -> dict[str, tuple[str, tuple[int, ...]]]:
    """dtype and shape per feature, the part that has to match across sources."""
    return {k: (f.dtype, tuple(f.shape)) for k, f in ds.features.items()}


def check_compatible(datasets: list[tuple[str, LeRobotDataset]]) -> None:
    """Raise unless every source has the same fps and the same features."""
    if not datasets:
        raise MergeError("nothing to merge")
    base_name, base = datasets[0]
    for name, ds in datasets[1:]:
        if abs(ds.fps - base.fps) > 1e-6:
            raise MergeError(f"different fps: '{base_name}' is {base.fps}, '{name}' is {ds.fps}")
        a, b = _feature_signature(base), _feature_signature(ds)
        if a != b:
            only_a = sorted(set(a) - set(b))
            only_b = sorted(set(b) - set(a))
            changed = sorted(k for k in set(a) & set(b) if a[k] != b[k])
            parts = []
            if only_a:
                parts.append(f"only in '{base_name}': {', '.join(only_a)}")
            if only_b:
                parts.append(f"only in '{name}': {', '.join(only_b)}")
            for k in changed:
                parts.append(
                    f"{k} is {a[k][0]}{list(a[k][1])} in '{base_name}' and {b[k][0]}{list(b[k][1])} in '{name}'"
                )
            raise MergeError("the datasets have different features · " + " · ".join(parts))


# ---------------------------------------------------------------------------
# Per-episode statistics
# ---------------------------------------------------------------------------


def _episode_stats(ds: LeRobotDataset) -> dict[int, dict[str, Any]]:
    """``meta/episodes_stats.jsonl`` of a source, by episode index. Empty when it has none."""
    p = ds.root / "meta" / "episodes_stats.jsonl"
    if not p.is_file():
        return {}
    out: dict[int, dict[str, Any]] = {}
    for line in p.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if "episode_index" in row and "stats" in row:
            out[int(row["episode_index"])] = row["stats"]
    return out


def _as_list(value: Any) -> list[float]:
    if isinstance(value, list):
        return (
            [x for v in value for x in _as_list(v)] if value and isinstance(value[0], list) else list(value)
        )
    return [value]


def aggregate_stats(per_episode: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """
    Combine per-episode statistics into one dataset-level ``meta/stats.json``.

    min and max are element-wise, the mean is weighted by the frame count and
    the standard deviation is rebuilt from the second moments, so the result is
    exactly what a single pass over the merged frames would produce. A feature
    that is missing from one episode is left out entirely rather than averaged
    over the episodes that happen to have it.
    """
    stats = list(per_episode)
    if not stats:
        return {}
    keys = set(stats[0])
    for s in stats[1:]:
        keys &= set(s)
    out: dict[str, Any] = {}
    for key in sorted(keys):
        entries = [s[key] for s in stats]
        if not all(isinstance(e, dict) and "mean" in e and "count" in e for e in entries):
            continue
        shape = len(_as_list(entries[0]["mean"]))
        counts = [float(_as_list(e["count"])[0]) for e in entries]
        total = sum(counts)
        if total <= 0 or any(len(_as_list(e["mean"])) != shape for e in entries):
            continue
        mean, std, lo, hi = [], [], [], []
        for i in range(shape):
            m = sum(c * _as_list(e["mean"])[i] for c, e in zip(counts, entries, strict=True)) / total
            second = (
                sum(
                    c * (_as_list(e.get("std", [0] * shape))[i] ** 2 + _as_list(e["mean"])[i] ** 2)
                    for c, e in zip(counts, entries, strict=True)
                )
                / total
            )
            mean.append(m)
            std.append(math.sqrt(max(second - m * m, 0.0)))
            lo.append(min(_as_list(e["min"])[i] for e in entries) if all("min" in e for e in entries) else m)
            hi.append(max(_as_list(e["max"])[i] for e in entries) if all("max" in e for e in entries) else m)
        out[key] = {"min": lo, "max": hi, "mean": mean, "std": std, "count": [int(total)]}
    return out


# ---------------------------------------------------------------------------
# Video
# ---------------------------------------------------------------------------


def _copy_video(src: Path, dest: Path, window: tuple[float, float] | None) -> None:
    """
    One episode's video. A file that holds exactly this episode is copied as it
    is (no re-encode, no quality loss). A packed v3 file is cut to the window,
    and that cut is re-encoded: a stream copy can only start on a keyframe and
    would hand back somebody else's frames at the front.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    if window is None:
        shutil.copy2(src, dest)
        return
    start, end = window
    cmd = [
        ffmpeg_exe(),
        "-y",
        "-loglevel",
        "error",
        "-ss",
        f"{start:.6f}",
        "-to",
        f"{end:.6f}",
        "-i",
        str(src),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-an",
        str(dest),
    ]
    done = subprocess.run(cmd, capture_output=True)
    if done.returncode != 0 or not dest.is_file():
        raise MergeError(f"could not cut {src.name}: {done.stderr.decode(errors='replace')[-400:]}")


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------


def merge_datasets(
    sources: list[MergeSource], out_root: str | Path, *, with_videos: bool = True
) -> MergeResult:
    """
    Write the selected episodes of `sources` as one LeRobot v2.1 dataset under
    `out_root`. The episodes keep the order of the sources and the order inside
    each source; they are numbered 0..n-1 without gaps.
    """
    out_root = Path(out_root)
    loaded: list[tuple[MergeSource, LeRobotDataset]] = []
    for s in sources:
        if not s.episodes:
            continue
        ds = open_dataset(s.root)
        missing = [e for e in s.episodes if e not in ds.episodes]
        if missing:
            raise MergeError(f"'{s.name}' has no episode {', '.join(str(m) for m in missing)}")
        loaded.append((s, ds))
    if not loaded:
        raise MergeError("no episodes selected")
    check_compatible([(s.name, ds) for s, ds in loaded])

    base = loaded[0][1]
    cameras = base.camera_keys
    (out_root / "meta").mkdir(parents=True, exist_ok=True)

    warnings: list[str] = []
    tasks: list[str] = []
    task_index: dict[str, int] = {}
    episodes_meta: list[dict[str, Any]] = []
    merged: list[MergedEpisode] = []
    stats_rows: list[dict[str, Any]] = []
    have_all_stats = True
    frame_offset = 0
    new_index = 0

    for source, ds in loaded:
        stats_of = _episode_stats(ds)
        for ep in source.episodes:
            df = ds.load_frame_table(ep).copy()
            n = len(df)
            task = ds.episode(ep).task
            if task not in task_index:
                task_index[task] = len(tasks)
                tasks.append(task)

            # renumber everything that points at a position in the dataset
            if "episode_index" in df.columns:
                df["episode_index"] = new_index
            if "frame_index" in df.columns:
                df["frame_index"] = range(n)
            if "index" in df.columns:
                df["index"] = range(frame_offset, frame_offset + n)
            if "task_index" in df.columns:
                df["task_index"] = task_index[task]

            target = out_root / DATA_PATH.format(
                episode_chunk=new_index // CHUNK_SIZE, episode_index=new_index
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            df.to_parquet(target, index=False)

            if with_videos:
                for cam in cameras:
                    src = ds.video_path(ep, cam)
                    if not src.is_file():
                        warnings.append(f"'{source.name}' episode {ep}: no video for {cam}")
                        continue
                    _copy_video(
                        src,
                        out_root
                        / VIDEO_PATH.format(
                            episode_chunk=new_index // CHUNK_SIZE, video_key=cam, episode_index=new_index
                        ),
                        ds.video_window(ep, cam),
                    )

            episodes_meta.append({"episode_index": new_index, "tasks": [task], "length": n})
            merged.append(
                MergedEpisode(index=new_index, source=source.name, source_episode=ep, length=n, task=task)
            )
            if ep in stats_of:
                stats_rows.append(stats_of[ep])
            else:
                have_all_stats = False
            frame_offset += n
            new_index += 1

    meta = out_root / "meta"
    (meta / "episodes.jsonl").write_text("\n".join(json.dumps(e) for e in episodes_meta) + "\n")
    (meta / "tasks.jsonl").write_text(
        "\n".join(json.dumps({"task_index": i, "task": t}) for i, t in enumerate(tasks)) + "\n"
    )

    if have_all_stats and stats_rows:
        (meta / "episodes_stats.jsonl").write_text(
            "\n".join(
                json.dumps({"episode_index": m.index, "stats": s})
                for m, s in zip(merged, stats_rows, strict=True)
            )
            + "\n"
        )
        aggregate = aggregate_stats(stats_rows)
        if aggregate:
            (meta / "stats.json").write_text(json.dumps(aggregate, indent=1))
        else:
            warnings.append("no dataset statistics: the per-episode statistics could not be combined")
    else:
        warnings.append("no statistics: at least one source has no meta/episodes_stats.jsonl")

    info = dict(base.info)
    info.update(
        {
            "codebase_version": "v2.1",
            "total_episodes": len(merged),
            "total_frames": frame_offset,
            "total_tasks": len(tasks),
            "total_videos": len(merged) * len(cameras) if with_videos else 0,
            "total_chunks": max(1, (len(merged) + CHUNK_SIZE - 1) // CHUNK_SIZE),
            "chunks_size": CHUNK_SIZE,
            "splits": {"train": f"0:{len(merged)}"},
            "data_path": DATA_PATH,
            "video_path": VIDEO_PATH,
        }
    )
    (meta / "info.json").write_text(json.dumps(info, indent=1))

    return MergeResult(
        root=out_root,
        episodes=merged,
        frames=frame_offset,
        tasks=tasks,
        cameras=cameras,
        fps=base.fps,
        robot_type=base.robot_type,
        warnings=warnings,
    )


def merge_manifest(result: MergeResult, name: str) -> dict[str, Any]:
    """What went into the merged dataset, for the manifest next to it."""
    by_source: dict[str, list[dict[str, int]]] = {}
    for e in result.episodes:
        by_source.setdefault(e.source, []).append({"episode": e.index, "sourceEpisode": e.source_episode})
    return {
        "name": name,
        "codebaseVersion": "v2.1",
        "episodes": len(result.episodes),
        "frames": result.frames,
        "fps": result.fps,
        "robotType": result.robot_type,
        "cameras": result.cameras,
        "tasks": result.tasks,
        "sources": [{"dataset": k, "episodes": v} for k, v in by_source.items()],
        "warnings": result.warnings,
    }
