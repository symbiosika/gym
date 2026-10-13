"""LeRobot v3.0 packed layout: one parquet + one mp4 per camera for all episodes, with
meta/episodes/*.parquet carrying data/video locations. Built from the v2.1 fixture."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from lerobot_critics.dataset import open_dataset
from lerobot_critics.dataset.video import ffmpeg_exe


@pytest.fixture(scope="session")
def v3_dataset(synthetic_dataset: Path, tmp_path_factory) -> Path:
    src = open_dataset(synthetic_dataset)
    root = tmp_path_factory.mktemp("lerobot_v3")
    (root / "meta" / "episodes").mkdir(parents=True)
    (root / "data" / "chunk-000").mkdir(parents=True)
    frames = []
    rows = []
    offset = 0
    for ep in src.episode_indices():
        df = src.load_frame_table(ep)
        frames.append(df)
        row = {
            "episode_index": ep,
            "length": len(df),
            "tasks": [src.task_for(ep)],
            "data/chunk_index": 0,
            "data/file_index": 0,
            "dataset_from_index": offset,
            "dataset_to_index": offset + len(df),
        }
        for cam in src.camera_keys:
            row[f"videos/{cam}/chunk_index"] = 0
            row[f"videos/{cam}/file_index"] = 0
            row[f"videos/{cam}/from_timestamp"] = offset / src.fps
            row[f"videos/{cam}/to_timestamp"] = (offset + len(df)) / src.fps
        rows.append(row)
        offset += len(df)
    pd.concat(frames, ignore_index=True).to_parquet(root / "data" / "chunk-000" / "file-000.parquet")
    pd.DataFrame(rows).to_parquet(root / "meta" / "episodes" / "chunk-000.parquet")
    for cam in src.camera_keys:
        lst = root / f"{cam}.txt"
        lst.write_text("".join(f"file '{src.video_path(ep, cam)}'\n" for ep in src.episode_indices()))
        out = root / "videos" / cam / "chunk-000" / "file-000.mp4"
        out.parent.mkdir(parents=True)
        subprocess.run(
            [
                ffmpeg_exe(),
                "-y",
                "-loglevel",
                "error",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(lst),
                "-c",
                "copy",
                str(out),
            ],
            check=True,
        )
    info = dict(src.info)
    info["codebase_version"] = "v3.0"
    info["data_path"] = "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet"
    info["video_path"] = "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4"
    (root / "meta" / "info.json").write_text(json.dumps(info))
    shutil.copy(synthetic_dataset / "meta" / "tasks.jsonl", root / "meta" / "tasks.jsonl")
    return root


def test_v3_loader_matches_v21(synthetic_dataset, v3_dataset):
    a, b = open_dataset(synthetic_dataset), open_dataset(v3_dataset)
    assert b.is_v3 and b.episode_indices() == a.episode_indices()
    for ep in a.episode_indices():
        ea, eb = a.episode(ep), b.episode(ep)
        assert eb.length == ea.length
        assert np.allclose(ea.array("action.arm"), eb.array("action.arm"))
        cam = a.camera_keys[0]
        fa = dict(ea.frames(cam, indices=[0, 5, ea.length - 1]))
        fb = dict(eb.frames(cam, indices=[0, 5, ea.length - 1]))
        assert fa.keys() == fb.keys()
        for i in fa:
            # same content up to re-muxing (copy codec -> identical frames expected)
            assert np.abs(fa[i].astype(int) - fb[i].astype(int)).mean() < 2.0, (ep, i)


def test_v3_hard_critics_run(v3_dataset, spec, tmp_path):
    from lerobot_critics.runner import RunOptions, run

    rep = run(
        v3_dataset,
        spec,
        RunOptions(out_dir=str(tmp_path / "o"), workers=1, run_soft=False, contact_sheets=False),
    )
    verdict = {e.episode: e.score.verdict for e in rep.episodes}
    assert verdict[0] == "accept" and verdict[3] in ("reject", "review")
    integ = next(h for e in rep.episodes if e.episode == 0 for h in e.hard if h.id == "integrity")
    assert integ.score == 1.0
