import numpy as np

from lerobot_critics.dataset import open_dataset
from lerobot_critics.dataset.features import detect_features


def test_open_and_episode(synthetic_dataset, spec):
    ds = open_dataset(synthetic_dataset)
    assert ds.fps == 10
    assert ds.episode_indices() == [0, 1, 2, 3]
    assert len(ds.camera_keys) == 2
    ep = ds.episode(1)
    assert ep.length == 70
    assert ep.array("action.arm").shape == (70, 9)
    assert ep.task == "put the red block in the box"
    frames = list(ep.frames(ds.camera_keys[0], indices=[0, 10, 69]))
    assert [i for i, _ in frames] == [0, 10, 69]
    assert frames[0][1].shape == (120, 160, 3)
    gray = list(ep.frames(ds.camera_keys[0], indices=[5], gray=True))
    assert gray[0][1].ndim == 2


def test_feature_detection(synthetic_dataset, spec):
    ds = open_dataset(synthetic_dataset)
    rf = detect_features(ds, spec, ds.episode(0))
    kinds = {p.action: p.kind for p in rf.pairs}
    assert kinds["action.arm"] == "cartesian"
    assert kinds["action.gripper"] == "hand"
    assert rf.gripper is not None and rf.gripper.feature == "observation.state.gripper"
    assert rf.primary_camera == "observation.images.front"
    assert rf.wrist_cameras == ["observation.images.wrist"]


def test_video_info(synthetic_dataset):
    ds = open_dataset(synthetic_dataset)
    info = ds.episode(0).video_info(ds.camera_keys[0])
    assert info.frames == 60
    assert np.isclose(info.fps, 10)


def test_episode_task_resolved_from_parquet_task_index(synthetic_dataset, tmp_path):
    """When meta/episodes carries no task text, the parquet's task_index resolves it."""
    import json
    import shutil

    import pandas as pd

    root = tmp_path / "ds"
    shutil.copytree(synthetic_dataset, root)
    tasks = ["put the red block in the box", "put the blue block in the box"]
    (root / "meta" / "tasks.jsonl").write_text(
        "\n".join(json.dumps({"task_index": i, "task": t}) for i, t in enumerate(tasks)) + "\n"
    )
    # strip the per-episode task text so only task_index is left to go on
    lines = (root / "meta" / "episodes.jsonl").read_text().splitlines()
    rows = [json.loads(x) for x in lines if x.strip()]
    for r in rows:
        r.pop("tasks", None)
    (root / "meta" / "episodes.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    for ep in (0, 1, 2, 3):
        p = root / "data" / "chunk-000" / f"episode_{ep:06d}.parquet"
        df = pd.read_parquet(p)
        df["task_index"] = ep % 2
        df.to_parquet(p)

    ds = open_dataset(root)
    assert [ds.episode(e).task for e in (0, 1, 2, 3)] == [tasks[0], tasks[1], tasks[0], tasks[1]]


def test_has_varying_tasks(synthetic_dataset, tmp_path):
    import json
    import shutil

    assert open_dataset(synthetic_dataset).has_varying_tasks is False

    root = tmp_path / "ds_multi"
    shutil.copytree(synthetic_dataset, root)
    (root / "meta" / "tasks.jsonl").write_text(
        "\n".join(json.dumps({"task_index": i, "task": f"task {i}"}) for i in range(3)) + "\n"
    )
    assert open_dataset(root).has_varying_tasks is True
