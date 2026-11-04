"""robot.active_arms must decide what is *scored*, and all-zero dropout rows must not be
read as commands by the arm critics (they are a logging fault, not a robot fault)."""

from __future__ import annotations

import json
from types import SimpleNamespace

from lerobot_critics.critics import build_hard_critics
from lerobot_critics.critics.base import CriticResult
from lerobot_critics.dataset.features import detect_features
from lerobot_critics.dataset.loader import open_dataset
from lerobot_critics.spec.models import HardCriticConfig


def _critic(spec, cid):
    spec.hard_critics = [HardCriticConfig(id=cid)]
    return build_hard_critics(spec)[0]


def test_inactive_arm_error_flags_but_does_not_lower_the_score(synthetic_dataset, spec):
    """An idle arm 300 mm off its command is INACTIVE_ARM_TRACKERR, nothing more: the score
    belongs to the active pairs (here only the gripper, which tracks perfectly)."""
    ds = open_dataset(synthetic_dataset)
    ep = ds.episode(0)
    rf = detect_features(ds, spec, ep)
    for p in rf.pairs:
        if p.kind == "cartesian":
            p.active = False
    ep.cache["features"] = rf
    st = ep.array("observation.state.arm")
    st[:, :3] += 0.3
    ep.df["observation.state.arm"] = list(st.astype("float32"))
    r = _critic(spec, "tracking_error").safe_evaluate(ep)
    assert r.error is None, r.error
    assert "INACTIVE_ARM_TRACKERR" in r.flags and "TRACKERR" not in r.flags
    assert r.metrics["pos_err_mean_mm.action.arm"] > 250
    assert r.score == 1.0, r.score


def test_range_inflation_skips_dims_that_never_moved(spec, tmp_path):
    """A parked arm has a true range of ~0; dividing stats.json's range by it yields 1e8x
    'inflation' that means nothing. Only dims that actually moved can be inflated."""
    crit = _critic(spec, "normalization")
    (tmp_path / "meta").mkdir()
    (tmp_path / "meta" / "stats.json").write_text(
        json.dumps(
            {
                "observation.state.parked": {"min": [0.0, -0.5, 0.0], "max": [0.1, 0.0, 0.9]},
                "action.moving": {"min": [-1.0, 0.0], "max": [2.0, 1.0]},
            }
        )
    )
    crit.ds = SimpleNamespace(root=tmp_path)
    results = [
        CriticResult(
            id="normalization",
            kind="hard",
            metrics={
                "_range.observation.state.parked": [[0.1, -0.5, 0.9], [0.1, -0.5, 0.9]],
                "_range.action.moving": [[0.0, 0.0], [1.0, 1.0]],
                "zero_frames": 0,
                "_episode": i,
            },
        )
        for i in range(2)
    ]
    out = crit.summarize(results)
    inflated = out.get("range_inflated_features", {})
    assert "observation.state.parked" not in inflated, inflated
    assert inflated["action.moving"]["dims"] == [0]  # 3 / 1 = 3x on the first dim only
    assert out["range_inflation_max"] == 3.0
    assert "STATS_RANGE_INFLATED" in out["flags"] and "parked" not in out["flags"]["STATS_RANGE_INFLATED"]


def test_zero_action_prefix_is_not_read_as_a_command(synthetic_dataset, spec):
    """2.5 s of all-zero action rows at the start (the logger started before the policy) must
    not become a 340 mm tracking error, a 10 m/s spike, a frozen command or a saturated axis."""
    ds = open_dataset(synthetic_dataset)
    ep = ds.episode(1)
    a = ep.array("action.arm")
    a[:25] = 0.0
    ep.df["action.arm"] = list(a.astype("float32"))

    te = _critic(spec, "tracking_error").safe_evaluate(ep)
    assert te.error is None and "TRACKERR" not in te.flags, (te.flags, te.evidence)
    assert te.score > 0.8 and te.metrics["pos_err_mean_mm.action.arm"] < 10, te.metrics
    assert te.metrics["dropout_rows"] == 25

    sm = _critic(spec, "smoothness").safe_evaluate(ep)
    assert sm.error is None and sm.metrics["spikes"] == 0 and "ACTION_SPIKES" not in sm.flags, sm.metrics

    du = _critic(spec, "duplication").safe_evaluate(ep)
    assert du.error is None and "LAGGY" not in du.flags, (du.flags, du.evidence)
    assert du.metrics["action_dup_rate"] < 0.05

    sl = _critic(spec, "sensor_limits").safe_evaluate(ep)
    assert sl.error is None
    assert not [x for x in sl.metrics.get("saturation", []) if x["feature"] == "action.arm"], sl.metrics


def test_dropout_mask_survives_a_joint_pair_before_a_cartesian_pair(synthetic_dataset, spec):
    """The joint branch builds its own per-dimension mask; it must not replace the per-row
    dropout mask used for the pairs after it."""
    from lerobot_critics.dataset.features import FeaturePair

    ds = open_dataset(synthetic_dataset)
    ep = ds.episode(1)
    a = ep.array("action.arm")
    a[30:35] = 0.0  # mid-episode, so the start-up cut does not hide them
    ep.df["action.arm"] = list(a.astype("float32"))
    rf = detect_features(ds, spec, ep)
    cart = next(p for p in rf.pairs if p.kind == "cartesian")
    joint = FeaturePair(cart.action, cart.state, [], "joints", None, True)
    rf.pairs = [joint, cart]
    ep.cache["features"] = rf
    r = _critic(spec, "tracking_error").safe_evaluate(ep)
    assert r.error is None, r.error
    assert r.metrics["dropout_rows"] == 5
    assert r.metrics["pos_err_mean_mm.action.arm"] < 10, r.metrics
