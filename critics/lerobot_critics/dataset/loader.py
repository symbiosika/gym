"""LeRobot dataset access (codebase v2.x per-episode files and v3.0 packed files).

The loader is deliberately small: it reads ``meta/info.json``, resolves the parquet
slice and the video file(s) for one episode and hands a :class:`EpisodeContext` to
the critics. Nothing here depends on the ``lerobot`` package.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .video import VideoInfo, iter_frames, probe_video


class DatasetFormatError(RuntimeError):
    pass


@dataclass
class FeatureInfo:
    key: str
    dtype: str
    shape: tuple[int, ...]
    names: list[str] | None

    @property
    def is_video(self) -> bool:
        return self.dtype in ("video", "image")

    @property
    def is_numeric(self) -> bool:
        return self.dtype in ("float32", "float64", "int32", "int64", "int16", "uint8", "bool")


@dataclass
class EpisodeMeta:
    index: int
    length: int
    tasks: list[str]
    # v3.0 packed layout only
    data_chunk: int | None = None
    data_file: int | None = None
    data_from: int | None = None
    data_to: int | None = None
    video_loc: dict[str, dict[str, Any]] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)


class LeRobotDataset:
    """Read-only view on a LeRobot dataset directory."""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        info_path = self.root / "meta" / "info.json"
        if not info_path.is_file():
            raise DatasetFormatError(f"{self.root} is not a LeRobot dataset (missing meta/info.json)")
        self.info: dict[str, Any] = json.loads(info_path.read_text())
        self.version: str = str(self.info.get("codebase_version", "v2.1"))
        self.fps: float = float(self.info.get("fps", 30))
        self.robot_type: str = str(self.info.get("robot_type") or "unknown")
        self.features: dict[str, FeatureInfo] = {
            k: FeatureInfo(k, v.get("dtype", ""), tuple(v.get("shape", ())), v.get("names"))
            for k, v in self.info.get("features", {}).items()
        }
        self.tasks: dict[int, str] = self._load_tasks()
        self.episodes: dict[int, EpisodeMeta] = self._load_episodes()

    # ------------------------------------------------------------------ meta
    @property
    def is_v3(self) -> bool:
        m = re.match(r"v?(\d+)", self.version)
        return bool(m) and int(m.group(1)) >= 3

    @property
    def camera_keys(self) -> list[str]:
        return [k for k, f in self.features.items() if f.is_video]

    @property
    def numeric_keys(self) -> list[str]:
        return [
            k
            for k, f in self.features.items()
            if f.is_numeric and k not in ("timestamp", "frame_index", "episode_index", "index", "task_index")
        ]

    def episode_indices(self) -> list[int]:
        return sorted(self.episodes)

    @property
    def has_varying_tasks(self) -> bool:
        """True when the episodes were recorded under more than one task instruction.

        Such a dataset has no single instruction that describes every episode, so the VLM judge must
        take the task per episode (see ``TaskSpec.per_episode``).
        """
        if len(self.tasks) > 1:
            return True
        return len({t for m in self.episodes.values() for t in m.tasks}) > 1

    def task_for(self, ep: int) -> str:
        meta = self.episodes[ep]
        if meta.tasks:
            return meta.tasks[0]
        return next(iter(self.tasks.values()), "")

    def _load_tasks(self) -> dict[int, str]:
        p = self.root / "meta" / "tasks.jsonl"
        if p.is_file():
            out = {}
            for line in p.read_text().splitlines():
                if line.strip():
                    row = json.loads(line)
                    out[int(row["task_index"])] = str(row["task"])
            return out
        p = self.root / "meta" / "tasks.parquet"
        if p.is_file():
            df = pd.read_parquet(p)
            if "task_index" in df.columns:
                return {int(r.task_index): str(getattr(r, "task", r.Index)) for r in df.itertuples()}
            return {int(i): str(idx) for i, idx in enumerate(df.index)}
        return {}

    def _load_episodes(self) -> dict[int, EpisodeMeta]:
        jl = self.root / "meta" / "episodes.jsonl"
        if jl.is_file():
            out = {}
            for line in jl.read_text().splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                idx = int(row["episode_index"])
                out[idx] = EpisodeMeta(
                    index=idx,
                    length=int(row["length"]),
                    tasks=list(row.get("tasks") or []),
                    extra={k: v for k, v in row.items() if k not in ("episode_index", "length", "tasks")},
                )
            return out
        ep_dir = self.root / "meta" / "episodes"
        files = sorted(ep_dir.rglob("*.parquet")) if ep_dir.is_dir() else []
        if not files:
            raise DatasetFormatError("no meta/episodes.jsonl or meta/episodes/*.parquet found")
        df = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
        out = {}
        for _, row in df.iterrows():
            idx = int(row["episode_index"])
            video_loc: dict[str, dict[str, Any]] = {}
            for cam in self.camera_keys:
                pref = f"videos/{cam}/"
                if f"{pref}chunk_index" in row:
                    video_loc[cam] = {
                        "chunk": int(row[f"{pref}chunk_index"]),
                        "file": int(row[f"{pref}file_index"]),
                        "from": float(row.get(f"{pref}from_timestamp", 0.0)),
                        "to": float(row.get(f"{pref}to_timestamp", 0.0)),
                    }
            tasks = row.get("tasks")
            if isinstance(tasks, np.ndarray):
                tasks = tasks.tolist()
            out[idx] = EpisodeMeta(
                index=idx,
                length=int(row["length"]),
                tasks=list(tasks or []),
                data_chunk=int(row["data/chunk_index"]) if "data/chunk_index" in row else None,
                data_file=int(row["data/file_index"]) if "data/file_index" in row else None,
                data_from=int(row["dataset_from_index"]) if "dataset_from_index" in row else None,
                data_to=int(row["dataset_to_index"]) if "dataset_to_index" in row else None,
                video_loc=video_loc,
            )
        return out

    # ------------------------------------------------------------------ paths
    def parquet_path(self, ep: int) -> Path:
        meta = self.episodes[ep]
        tmpl = self.info.get(
            "data_path", "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet"
        )
        chunk_size = int(self.info.get("chunks_size", 1000))
        if meta.data_chunk is not None and meta.data_file is not None:
            return self.root / tmpl.format(chunk_index=meta.data_chunk, file_index=meta.data_file)
        return self.root / tmpl.format(episode_chunk=ep // chunk_size, episode_index=ep)

    def video_path(self, ep: int, camera: str) -> Path:
        meta = self.episodes[ep]
        tmpl = self.info.get(
            "video_path", "videos/chunk-{episode_chunk:03d}/{video_key}/episode_{episode_index:06d}.mp4"
        )
        chunk_size = int(self.info.get("chunks_size", 1000))
        loc = meta.video_loc.get(camera)
        if loc is not None:
            return self.root / tmpl.format(video_key=camera, chunk_index=loc["chunk"], file_index=loc["file"])
        return self.root / tmpl.format(video_key=camera, episode_chunk=ep // chunk_size, episode_index=ep)

    def video_window(self, ep: int, camera: str) -> tuple[float, float] | None:
        """(from_s, to_s) inside a packed v3 file, or None when the file holds one episode."""
        loc = self.episodes[ep].video_loc.get(camera)
        if loc is None:
            return None
        return float(loc["from"]), float(loc["to"])

    # ------------------------------------------------------------------ data
    def load_frame_table(self, ep: int) -> pd.DataFrame:
        df = pd.read_parquet(self.parquet_path(ep))
        meta = self.episodes[ep]
        if "episode_index" in df.columns and df["episode_index"].nunique() > 1:
            df = df[df["episode_index"] == ep]
        elif meta.data_from is not None and meta.data_to is not None and len(df) > meta.length:
            df = df.iloc[meta.data_from : meta.data_to]
        return df.reset_index(drop=True)

    def episode(self, ep: int) -> EpisodeContext:
        if ep not in self.episodes:
            raise KeyError(f"episode {ep} not in dataset")
        return EpisodeContext(self, ep)


def open_dataset(path: str | Path) -> LeRobotDataset:
    return LeRobotDataset(path)


class EpisodeContext:
    """Everything a critic may want about one episode, loaded lazily and cached.

    ``cache`` is a scratch dict shared by all critics of one episode (e.g. the video
    scan is computed once and reused by duplication + image-quality critics).
    """

    def __init__(self, ds: LeRobotDataset, index: int):
        self.ds = ds
        self.index = index
        self.meta = ds.episodes[index]
        self.fps = ds.fps
        self.cache: dict[str, Any] = {}

    def __repr__(self) -> str:  # pragma: no cover
        return f"EpisodeContext(ep={self.index}, len={self.length})"

    @cached_property
    def df(self) -> pd.DataFrame:
        return self.ds.load_frame_table(self.index)

    @property
    def length(self) -> int:
        try:
            return int(len(self.df))
        except Exception:  # noqa: BLE001
            return int(self.meta.length)

    @property
    def duration_s(self) -> float:
        return self.length / self.fps

    @property
    def task(self) -> str:
        """The task text recorded for *this* episode.

        Most datasets carry it in ``meta/episodes`` (v3 packed: a parquet ``tasks`` column). When
        they do not, the data parquet's per-frame ``task_index`` resolves against ``meta/tasks``;
        only with neither present does this degrade to the dataset's single task.
        """
        if self.meta.tasks:
            return str(self.meta.tasks[0])
        if self.ds.tasks and self.has("task_index"):
            idx = self.df["task_index"].dropna()
            if len(idx):
                task = self.ds.tasks.get(int(idx.iloc[0]))
                if task:
                    return task
        return self.ds.task_for(self.index)

    @property
    def cameras(self) -> list[str]:
        return self.ds.camera_keys

    def has(self, key: str) -> bool:
        return key in self.df.columns

    def array(self, key: str) -> np.ndarray:
        """Return feature ``key`` as float array of shape (N, D)."""
        col = self.df[key]
        first = col.iloc[0]
        if isinstance(first, (list, np.ndarray)):
            arr = np.stack(col.to_numpy()).astype(np.float64)
        else:
            arr = col.to_numpy().astype(np.float64)[:, None]
        return arr

    def names(self, key: str) -> list[str]:
        f = self.ds.features.get(key)
        d = self.array(key).shape[1] if self.has(key) else (f.shape[0] if f and f.shape else 1)
        if f and f.names and len(f.names) == d:
            return list(f.names)
        return [f"{i}" for i in range(d)]

    def timestamps(self) -> np.ndarray | None:
        if "timestamp" in self.df.columns:
            return self.df["timestamp"].to_numpy().astype(np.float64)
        return None

    # --------------------------------------------------------------- video
    def video_path(self, camera: str) -> Path:
        return self.ds.video_path(self.index, camera)

    def video_info(self, camera: str) -> VideoInfo:
        key = f"vinfo:{camera}"
        if key not in self.cache:
            self.cache[key] = probe_video(self.video_path(camera))
        return self.cache[key]

    def frames(
        self,
        camera: str,
        indices: list[int] | None = None,
        step: int = 1,
        gray: bool = False,
        max_side: int | None = None,
    ) -> Iterator[tuple[int, np.ndarray]]:
        """Yield (frame_index_in_episode, image) for one camera.

        For packed v3 files the episode window is handled transparently.
        """
        window = self.ds.video_window(self.index, camera)
        yield from iter_frames(
            self.video_path(camera),
            indices=indices,
            step=step,
            gray=gray,
            max_side=max_side,
            window=window,
            fps=self.fps,
            length=self.length,
        )
