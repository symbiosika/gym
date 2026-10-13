import numpy as np

from lerobot_critics.critics import build_hard_critics
from lerobot_critics.critics.base import band, ramp, ramp_high
from lerobot_critics.critics.hard._util import longest_run, orientation_error_deg, rot6d_to_matrix
from lerobot_critics.critics.hard.grasp_cycles import detect_cycles
from lerobot_critics.dataset import open_dataset


def test_ramps():
    assert ramp(0, 1, 2) == 1.0 and ramp(2, 1, 2) == 0.0 and abs(ramp(1.5, 1, 2) - 0.5) < 1e-9
    assert ramp_high(5, 4, 2) == 1.0 and ramp_high(2, 4, 2) == 0.0
    assert (
        band(5, 4, 6, 1, 1) == 1.0 and band(3, 4, 6, 1, 1) == 0.0 and abs(band(3.5, 4, 6, 1, 1) - 0.5) < 1e-9
    )
    assert ramp(None, 0, 1) is None


def test_util():
    assert longest_run(np.array([0, 1, 1, 0, 1, 1, 1, 0], bool)) == 3
    r = np.tile(np.array([1, 0, 0, 0, 1, 0], float), (4, 1))
    R = rot6d_to_matrix(r)
    assert np.allclose(R[0], np.eye(3))
    a = np.zeros((4, 9))
    a[:, 3:] = r
    b = a.copy()
    # rotate second column by 90 deg around x: (0,1,0) -> (0,0,1)
    b[:, 6:9] = [0, 0, 1]
    err = orientation_error_deg(a, b)
    assert np.allclose(err, 90.0, atol=1e-6)


def test_detect_cycles():
    fps = 10
    sig = np.zeros(200)
    sig[30:80] = 1.0
    sig[120:170] = 1.0
    det = detect_cycles(sig, fps)
    assert det["n_cycles"] == 2
    assert abs(det["cycles"][0]["grasp"] - 30) <= 3
    assert abs(det["cycles"][0]["release"] - 80) <= 3
    assert detect_cycles(np.zeros(100), fps)["n_cycles"] == 0
    # unfinished grasp at the end
    sig2 = np.zeros(100)
    sig2[60:] = 1.0
    d2 = detect_cycles(sig2, fps)
    assert d2["n_cycles"] == 1 and d2["cycles"][0]["release"] is None


def _run_all(ds, spec, ep_index):
    ep = ds.episode(ep_index)
    return {c.id: c.safe_evaluate(ep) for c in build_hard_critics(spec)}


def test_good_episode_scores_high(synthetic_dataset, spec):
    ds = open_dataset(synthetic_dataset)
    res = _run_all(ds, spec, 0)
    assert all(r.error is None for r in res.values()), {k: r.error for k, r in res.items() if r.error}
    assert res["integrity"].score == 1.0
    assert res["grasp_cycles"].metrics["n_cycles"] == 1
    assert res["grasp_cycles"].score == 1.0
    assert res["duplication"].score > 0.8, res["duplication"].metrics
    assert res["tracking_error"].score > 0.8, res["tracking_error"].metrics
    assert res["tracking_error"].metrics["lag_frames.action.arm"] == 2
    assert res["image_quality"].score is not None


def test_broken_episode_is_caught(synthetic_dataset, spec):
    ds = open_dataset(synthetic_dataset)
    res = _run_all(ds, spec, 2)
    dup = res["duplication"]
    assert "LAGGY" in dup.flags, dup.metrics
    assert dup.metrics["action_dup_rate"] > 0.2
    assert dup.score < 0.5


def test_no_grasp_episode(synthetic_dataset, spec):
    ds = open_dataset(synthetic_dataset)
    res = _run_all(ds, spec, 3)
    assert "NOGRASP" in res["grasp_cycles"].flags
    assert res["grasp_cycles"].score == 0.0


def test_sensor_limits(synthetic_dataset, spec):
    from lerobot_critics.spec.models import HardCriticConfig

    spec.hard_critics = [
        HardCriticConfig(id="sensor_limits", params={"limits": {"observation.state.arm": {"z": [0.0, 0.5]}}})
    ]
    ds = open_dataset(synthetic_dataset)
    r = build_hard_critics(spec)[0].safe_evaluate(ds.episode(0))
    assert "LIMIT_VIOLATION" in r.flags
    assert r.score == 0.0


def test_duration_bounds(synthetic_dataset, spec):
    from lerobot_critics.spec.models import HardCriticConfig

    spec.hard_critics = [HardCriticConfig(id="duration", params={"min_s": 10, "max_s": 20})]
    ds = open_dataset(synthetic_dataset)
    r = build_hard_critics(spec)[0].safe_evaluate(ds.episode(0))  # 6 s
    assert "TOO_SHORT" in r.flags and r.score < 0.5


def test_idle_closure_is_not_an_attempt(synthetic_dataset, spec, monkeypatch):
    """A gripper closure while the arm does not move must not count as a task attempt."""
    from lerobot_critics.critics.hard.grasp_cycles import GraspCyclesCritic

    ds = open_dataset(synthetic_dataset)
    ep = ds.episode(0)
    crit = build_hard_critics(spec)
    gc = next(c for c in crit if isinstance(c, GraspCyclesCritic))
    r = gc.safe_evaluate(ep)
    assert r.metrics["n_cycles"] == 1 and r.metrics["idle_closures"] == 0
    # freeze the arm: every closure becomes idle
    frozen = ep.array("observation.state.arm")
    frozen[:] = frozen[0]
    ep.df["observation.state.arm"] = list(frozen.astype("float32"))
    ep.cache.clear()
    r2 = gc.safe_evaluate(ep)
    assert r2.metrics["n_cycles"] == 0 and r2.metrics["idle_closures"] == 1
    assert "NOGRASP" in r2.flags
