"""Merging selected episodes of several datasets into one trainable dataset."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from lerobot_critics.dataset.loader import open_dataset
from lerobot_critics.merge import (
    MergeError,
    MergeSource,
    aggregate_stats,
    merge_datasets,
    merge_manifest,
)


@pytest.fixture
def second_dataset(synthetic_dataset: Path, tmp_path: Path) -> Path:
    """A copy of the fixture under another name and with another task."""
    root = tmp_path / "second"
    shutil.copytree(synthetic_dataset, root)
    (root / "meta" / "tasks.jsonl").write_text(
        json.dumps({"task_index": 0, "task": "stack the blue cube"}) + "\n"
    )
    lines = (root / "meta" / "episodes.jsonl").read_text().splitlines()
    rows = [json.loads(x) for x in lines if x.strip()]
    for r in rows:
        r["tasks"] = ["stack the blue cube"]
    (root / "meta" / "episodes.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return root


def test_merge_renumbers_episodes_without_gaps(synthetic_dataset: Path, second_dataset: Path, tmp_path: Path):
    out = tmp_path / "merged"
    result = merge_datasets(
        [
            MergeSource(root=synthetic_dataset, episodes=[0, 3], name="run-a"),
            MergeSource(root=second_dataset, episodes=[1], name="run-b"),
        ],
        out,
    )
    assert [e.index for e in result.episodes] == [0, 1, 2]
    assert [(e.source, e.source_episode) for e in result.episodes] == [
        ("run-a", 0),
        ("run-a", 3),
        ("run-b", 1),
    ]

    ds = open_dataset(out)
    assert ds.episode_indices() == [0, 1, 2]
    assert ds.info["total_episodes"] == 3
    assert ds.info["total_frames"] == result.frames
    assert ds.info["codebase_version"] == "v2.1"
    assert ds.info["splits"] == {"train": "0:3"}

    # every episode is readable and carries its new index, not the old one
    offset = 0
    for new, src_len in zip([0, 1, 2], [60, 60, 70], strict=True):
        df = ds.load_frame_table(new)
        assert len(df) == src_len
        assert set(df["episode_index"]) == {new}
        assert list(df["frame_index"]) == list(range(src_len))
        assert list(df["index"]) == list(range(offset, offset + src_len))
        offset += src_len
    assert offset == result.frames


def test_merge_builds_one_task_table(synthetic_dataset: Path, second_dataset: Path, tmp_path: Path):
    out = tmp_path / "merged"
    result = merge_datasets(
        [
            MergeSource(root=synthetic_dataset, episodes=[0], name="run-a"),
            MergeSource(root=second_dataset, episodes=[0], name="run-b"),
        ],
        out,
    )
    assert result.tasks == ["put the red block in the box", "stack the blue cube"]
    ds = open_dataset(out)
    assert ds.tasks == {0: "put the red block in the box", 1: "stack the blue cube"}
    assert ds.info["total_tasks"] == 2
    # the per-frame task_index points into the merged table
    assert set(ds.load_frame_table(0)["task_index"]) == {0}
    assert set(ds.load_frame_table(1)["task_index"]) == {1}
    assert ds.episode(1).task == "stack the blue cube"


def test_merge_takes_the_videos_over(synthetic_dataset: Path, tmp_path: Path):
    out = tmp_path / "merged"
    merge_datasets([MergeSource(root=synthetic_dataset, episodes=[2, 0], name="run-a")], out)
    ds = open_dataset(out)
    for ep in (0, 1):
        for cam in ds.camera_keys:
            assert ds.video_path(ep, cam).is_file()
    # the order of the selection decides: episode 2 of the source became 0
    assert (out / "videos" / "chunk-000" / ds.camera_keys[0] / "episode_000000.mp4").stat().st_size > 0


def test_merge_without_videos_writes_only_data_and_meta(synthetic_dataset: Path, tmp_path: Path):
    out = tmp_path / "merged"
    merge_datasets([MergeSource(root=synthetic_dataset, episodes=[0], name="a")], out, with_videos=False)
    assert not (out / "videos").exists()
    assert (out / "data" / "chunk-000" / "episode_000000.parquet").is_file()
    assert json.loads((out / "meta" / "info.json").read_text())["total_videos"] == 0


def test_merge_refuses_datasets_that_do_not_fit_together(synthetic_dataset: Path, tmp_path: Path):
    other = tmp_path / "other"
    shutil.copytree(synthetic_dataset, other)
    info = json.loads((other / "meta" / "info.json").read_text())
    info["fps"] = 30
    (other / "meta" / "info.json").write_text(json.dumps(info))
    with pytest.raises(MergeError, match="different fps"):
        merge_datasets(
            [
                MergeSource(root=synthetic_dataset, episodes=[0], name="a"),
                MergeSource(root=other, episodes=[0], name="b"),
            ],
            tmp_path / "merged",
        )

    third = tmp_path / "third"
    shutil.copytree(synthetic_dataset, third)
    info = json.loads((third / "meta" / "info.json").read_text())
    info["features"]["action.arm"]["shape"] = [7]
    (third / "meta" / "info.json").write_text(json.dumps(info))
    with pytest.raises(MergeError, match="different features"):
        merge_datasets(
            [
                MergeSource(root=synthetic_dataset, episodes=[0], name="a"),
                MergeSource(root=third, episodes=[0], name="c"),
            ],
            tmp_path / "merged2",
        )


def test_merge_refuses_an_episode_that_is_not_there(synthetic_dataset: Path, tmp_path: Path):
    with pytest.raises(MergeError, match="no episode 99"):
        merge_datasets([MergeSource(root=synthetic_dataset, episodes=[0, 99], name="a")], tmp_path / "m")
    with pytest.raises(MergeError, match="no episodes selected"):
        merge_datasets([MergeSource(root=synthetic_dataset, episodes=[], name="a")], tmp_path / "m2")


def test_manifest_says_where_every_episode_came_from(
    synthetic_dataset: Path, second_dataset: Path, tmp_path: Path
):
    result = merge_datasets(
        [
            MergeSource(root=synthetic_dataset, episodes=[0, 1], name="run-a"),
            MergeSource(root=second_dataset, episodes=[2], name="run-b"),
        ],
        tmp_path / "merged",
    )
    m = merge_manifest(result, "session-export")
    assert m["name"] == "session-export"
    assert m["episodes"] == 3
    assert m["codebaseVersion"] == "v2.1"
    assert m["sources"] == [
        {
            "dataset": "run-a",
            "episodes": [{"episode": 0, "sourceEpisode": 0}, {"episode": 1, "sourceEpisode": 1}],
        },
        {"dataset": "run-b", "episodes": [{"episode": 2, "sourceEpisode": 2}]},
    ]
    # the fixture has no per-episode statistics, and that is said rather than faked
    assert any("statistics" in w for w in m["warnings"])
    assert not (tmp_path / "merged" / "meta" / "stats.json").exists()


def test_statistics_are_combined_exactly():
    # two episodes of one feature: [0, 2] and [4, 6, 8]
    a = {"x": {"min": [0], "max": [2], "mean": [1.0], "std": [1.0], "count": [2]}}
    b = {"x": {"min": [4], "max": [8], "mean": [6.0], "std": [(8 / 3) ** 0.5], "count": [3]}}
    out = aggregate_stats([a, b])["x"]
    assert out["count"] == [5]
    assert out["min"] == [0]
    assert out["max"] == [8]
    assert out["mean"][0] == pytest.approx(4.0)
    # the same as numpy over [0, 2, 4, 6, 8]
    assert out["std"][0] == pytest.approx(2.8284271247, rel=1e-6)


def test_statistics_are_carried_over_when_the_sources_have_them(synthetic_dataset: Path, tmp_path: Path):
    src = tmp_path / "with-stats"
    shutil.copytree(synthetic_dataset, src)
    rows = [
        {
            "episode_index": ep,
            "stats": {"action.gripper": {"min": [0], "max": [1], "mean": [0.4], "std": [0.5], "count": [60]}},
        }
        for ep in range(4)
    ]
    (src / "meta" / "episodes_stats.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    out = tmp_path / "merged"
    result = merge_datasets([MergeSource(root=src, episodes=[3, 1], name="a")], out)
    assert result.warnings == []
    stats = json.loads((out / "meta" / "stats.json").read_text())
    assert stats["action.gripper"]["count"] == [120]
    written = [
        json.loads(x) for x in (out / "meta" / "episodes_stats.jsonl").read_text().splitlines() if x.strip()
    ]
    # renumbered to the merged indexes, in the merged order
    assert [r["episode_index"] for r in written] == [0, 1]
