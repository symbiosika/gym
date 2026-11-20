"""Shortcut figures over a selection and the prompt check (lerobot_critics.shortcuts).

The unit tests build episodes the way the diversity critic describes them; one run over the
two-arm fixture checks that the critic writes those features, and the API tests that the
service answers without keeping anything.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from lerobot_critics.merge import MergeSource, merge_datasets
from lerobot_critics.shortcuts import (
    Episode,
    align_prompts,
    analyse,
    changed_signature,
    colour_signature,
    episode_from,
    find_scenes,
    group_cv,
    thumbnail,
)

PROMPTS = ["red", "green", "blue"]
COLOURS = {"red": (200, 30, 30), "green": (30, 180, 40), "blue": (30, 40, 200)}


def _scene_picture(scene: int) -> np.ndarray:
    """A grey shelf with three coloured blocks whose order is the scene's."""
    img = np.full((18, 24, 3), 120, np.float64)
    order = [PROMPTS[(scene + j) % 3] for j in range(3)]
    for j, p in enumerate(order):
        img[6:12, 2 + 7 * j : 7 + 7 * j] = COLOURS[p]
    return img / 255.0


def _look(prompt: str, rng) -> np.ndarray:
    px = np.tile(np.array(COLOURS[prompt], np.uint8), (200, 1)).astype(int)
    px = np.clip(px + rng.integers(-15, 15, px.shape), 0, 255).astype(np.uint8)
    return np.asarray(colour_signature(px) * 2)


def _episodes(n_scenes=6, cue=False, one_prompt_per_scene=False, seed=0) -> list[Episode]:
    """``n_scenes`` scenes of three episodes. ``cue``: the start pose tells the arm."""
    rng = np.random.default_rng(seed)
    eps = []
    k = 0
    for s in range(n_scenes):
        for j in range(3):
            prompt = PROMPTS[s % 3] if one_prompt_per_scene else PROMPTS[j]
            arm = "left" if (k % 2) else "right"
            start = rng.normal(0, 0.01, 6)
            if cue:
                start[2] += 0.15 if arm == "left" else -0.15
            x = {"red": 0.1, "green": 0.3, "blue": 0.5}[prompt] + (s % 2) * 0.2
            eps.append(
                Episode(
                    key=str(k),
                    dataset="d1",
                    order=k,
                    prompt=prompt,
                    arm=arm,
                    start=start,
                    end=rng.normal(0, 0.01, 6),
                    thumb=(_scene_picture(s) + rng.normal(0, 0.005, (18, 24, 3))).reshape(-1),
                    grasp=np.array([x, 0.0, 0.1]),
                    look=_look(prompt, rng),
                )
            )
            k += 1
    return eps


def test_scenes_are_found_from_the_first_pictures():
    eps = _episodes()
    sc = find_scenes(eps)
    assert len(set(sc["labels"])) == 6
    assert sc["labels"][0] == sc["labels"][2] != sc["labels"][3]


def test_scenes_never_span_two_datasets():
    eps = _episodes(n_scenes=2)
    for e in eps[3:]:
        e.dataset = "d2"
    sc = find_scenes(eps)
    assert not set(sc["labels"][:3]) & set(sc["labels"][3:])


def test_group_cv_is_none_without_two_classes_or_scenes():
    x = np.zeros((10, 2))
    assert group_cv(x, ["a"] * 10, [str(i) for i in range(10)]) is None
    assert group_cv(x, ["a", "b"] * 5, ["s"] * 10) is None


def test_a_start_pose_that_tells_the_arm_is_flagged():
    out = analyse(_episodes(cue=True))
    assert out["start_cue"]["arm"]["accuracy"] == 1.0
    assert "START_CUE" in out["flags"]


def test_no_cue_no_flag_and_counterfactual_scenes_count():
    out = analyse(_episodes())
    assert "START_CUE" not in out["flags"]
    cf = out["counterfactual"]
    assert cf["scenes_multi_prompt"] == 1.0
    assert cf["episodes_with_partner"] == 1.0
    assert "FEW_COUNTERFACTUALS" not in out["flags"]


def test_one_prompt_per_scene_is_few_counterfactuals_and_a_background_cue():
    out = analyse(_episodes(one_prompt_per_scene=True))
    assert out["counterfactual"]["episodes_with_partner"] == 0.0
    assert "FEW_COUNTERFACTUALS" in out["flags"]
    # each scene's picture is a rotation of the blocks: the picture tells the prompt
    assert out["background"]["prompt"]["accuracy"] == 1.0
    assert "BACKGROUND_CUE" in out["flags"]


def test_layout_counts_cells_and_the_position_cue():
    out = analyse(_episodes())
    lay = out["layout"]
    # red is picked at 0.1 or 0.3, green at 0.3 or 0.5: the 0.3 cell held two targets
    assert lay["cells_multi_prompt"] > 0
    assert set(lay["per_prompt"]) == set(PROMPTS)
    assert lay["position_cue"] is not None


def test_evaluation_starts_out_of_range_and_one_sided():
    train = _episodes(cue=True)
    ev = [
        Episode(str(i), "ev", i, "red", None, np.array([0, 0, 0.15, 0, 0, 0.0]) + 5.0, None, None, None, None)
        for i in range(4)
    ]
    out = analyse(train, ev)
    assert out["evaluation"]["n"] == 4
    assert out["evaluation"]["in_range"] == 0.0
    assert "EVAL_START_OUT_OF_RANGE" in out["flags"]
    near = [Episode(str(i), "ev", i, "red", None, train[1].start, None, None, None, None) for i in range(5)]
    out = analyse(train, near)
    assert out["evaluation"]["in_range"] == 1.0
    assert out["evaluation"]["predicted_arm"] == {"left": 5}
    assert "EVAL_START_CUE" in out["flags"]


def test_a_wrong_prompt_is_proposed_from_the_reference():
    ref = _episodes(seed=1)
    targets = _episodes(n_scenes=2, seed=2)
    for t in targets:
        t.key = "t" + t.key
    targets[0].prompt = "blue"  # it picked the red block
    out = align_prompts(targets, ref)
    assert out["mode"] == "reference"
    rows = {r["id"]: r for r in out["episodes"]}
    assert rows["t0"]["status"] == "propose"
    assert rows["t0"]["proposed"] == "red"
    assert all(rows[t.key]["status"] == "ok" for t in targets[1:])


def test_look_alike_prompts_are_raised_for_review_never_proposed():
    rng = np.random.default_rng(3)
    ref = _episodes(seed=1)
    # "maroon" looks like red: the references mix them up
    for e in ref[:6]:
        e.prompt = "maroon" if int(e.key) % 2 else e.prompt
    for e in ref:
        if e.prompt == "maroon":
            e.look = _look("red", rng)
    t = _episodes(n_scenes=1, seed=4)
    t[0].key, t[0].prompt = "x", "maroon"
    out = align_prompts(t[:1], ref)
    assert out["confusable"]
    assert out["episodes"][0]["status"] in ("review", "ok")
    assert out["episodes"][0]["status"] != "propose"


def test_one_stand_in_prompt_is_grouped_for_a_person_to_name():
    targets = _episodes(seed=5)
    truth = [t.prompt for t in targets]
    for t in targets:
        t.prompt = "pick the object"
    out = align_prompts(targets, [], candidates=PROMPTS)
    assert out["mode"] == "groups"
    groups: dict[int, set] = {}
    for row, p in zip(out["episodes"], truth, strict=True):
        assert row["status"] == "review"
        groups.setdefault(row["group"], set()).add(p)
    assert len(groups) == 3 and all(len(v) == 1 for v in groups.values())


def test_signatures():
    a = np.full((30, 40, 3), 100, np.uint8)
    b = a.copy()
    assert changed_signature(a, b) is None
    a[10:20, 10:20] = (220, 20, 20)
    sig = changed_signature(a, b)
    assert sig is not None and len(sig) == 19
    assert len(thumbnail(a)) == 24 * 18 * 3


def test_episode_from_metrics_of_any_age():
    e = episode_from({}, "1")
    assert e.start is None and e.prompt is None
    m = {
        "grasp_arm": "left",
        "grasps_by_arm": {"left": {"grasp_pos_m": [[0.1, 0.2, 0.3]]}},
        "cue_features": {"prompt": "a", "start_state": [1, 2], "thumb": {"rgb": [255] * 6}},
    }
    e = episode_from(m, "1", prompt="b")
    assert e.prompt == "b"
    assert e.grasp.tolist() == [0.1, 0.2, 0.3]
    assert e.thumb.max() == 1.0


# --------------------------------------------------------------------------- the critic
@pytest.fixture(scope="module")
def two_arm_run(alternating_arm_dataset, tmp_path_factory):
    from lerobot_critics.runner import RunOptions, run
    from lerobot_critics.spec.models import CriticSpec, RobotSpec, SoftCriticsConfig, TaskSpec, VLMConfig

    spec = CriticSpec(
        name="t",
        task=TaskSpec(instruction="pick"),
        robot=RobotSpec(active_arms=["left", "right"]),
        soft_critics=SoftCriticsConfig(enabled=False, vlm=VLMConfig(provider="none")),
    )
    out = tmp_path_factory.mktemp("shortcut_run")
    return run(
        alternating_arm_dataset, spec, RunOptions(out_dir=str(out), run_soft=False, contact_sheets=False)
    )


def test_the_diversity_critic_writes_the_features_per_episode(two_arm_run):
    m = next(c for c in two_arm_run.episodes[0].hard if c.id == "diversity").metrics
    cf = m["cue_features"]
    assert cf["prompt"] == "pick the red block"
    assert len(cf["start_state"]) == len(cf["end_state"]) > 0
    assert cf["thumb"]["camera"] == "observation.images.front"
    assert len(cf["thumb"]["rgb"]) == 24 * 18 * 3
    json.dumps(cf)  # it goes into report.json as it is


def test_the_run_summary_carries_the_shortcuts(two_arm_run):
    sh = two_arm_run.dataset_summaries["diversity"]["shortcuts"]
    assert sh["n"] == 6
    assert "start_cue" in sh and "scenes" in sh


# --------------------------------------------------------------------------- the service
@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("CRITICS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CRITICS_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("CRITICS_SPECS_DIR", str(tmp_path / "specs"))
    import importlib

    import lerobot_critics.api.app as app_module

    importlib.reload(app_module)
    from fastapi.testclient import TestClient

    return TestClient(app_module.app)


def _wire(e: Episode) -> dict:
    return {
        "id": e.key,
        "dataset": e.dataset,
        "order": e.order,
        "prompt": e.prompt,
        "metrics": {
            "grasp_arm": e.arm,
            "grasps_by_arm": {e.arm: {"grasp_pos_m": [e.grasp.tolist()]}},
            "cue_features": {
                "start_state": e.start.tolist(),
                "end_state": e.end.tolist(),
                "thumb": {"rgb": [int(v) for v in (e.thumb * 255).clip(0, 255).reshape(-1)]},
                "look": e.look.tolist(),
            },
        },
    }


def test_post_analyses_shortcuts(api):
    body = {"episodes": [_wire(e) for e in _episodes(cue=True)]}
    r = api.post("/analyses/shortcuts", json=body)
    assert r.status_code == 200, r.text
    assert "START_CUE" in r.json()["flags"]


def test_post_analyses_prompts(api):
    ref = _episodes(seed=1)
    t = _episodes(n_scenes=1, seed=2)
    for e in t:
        e.key = "t" + e.key
    t[0].prompt = "green"
    r = api.post(
        "/analyses/prompts", json={"episodes": [_wire(e) for e in t], "reference": [_wire(e) for e in ref]}
    )
    assert r.status_code == 200, r.text
    rows = {x["id"]: x for x in r.json()["episodes"]}
    assert rows["t0"]["status"] == "propose" and rows["t0"]["proposed"] == "red"


def test_merge_writes_the_corrected_prompts(synthetic_dataset: Path, tmp_path: Path):
    from lerobot_critics.dataset.loader import open_dataset

    out = tmp_path / "merged"
    merge_datasets([MergeSource(synthetic_dataset, [0, 1], prompts={1: "pick the green cube"})], out)
    ds = open_dataset(out)
    assert ds.episode(1).task == "pick the green cube"
    assert ds.episode(0).task != "pick the green cube"
    assert len(ds.tasks) == 2
