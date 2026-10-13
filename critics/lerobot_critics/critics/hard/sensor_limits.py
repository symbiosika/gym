"""Sensor limits and dead zones on numeric features (robot-side technical indicators)."""

from __future__ import annotations

import numpy as np

from ...dataset.loader import EpisodeContext
from ...dataset.preroll import signal_start
from ..base import HardCritic, ramp
from ..registry import register
from ._util import longest_run


@register
class SensorLimitsCritic(HardCritic):
    id = "sensor_limits"
    description = (
        "Configured hard limits per feature dimension (values outside = violation), dead zones (ranges a value "
        "must not rest in), and generic saturation detection (a dimension pinned at its extreme for long runs, "
        "i.e. a clamp or a stuck sensor). Limits are given as {feature: {dim_or_name: [min, max]}}."
    )
    default_params = {
        # e.g. {"observation.state.humanoid_v1.left_wrist": {"z": [0.5, 1.5], "0": [-1, 1]}}
        "limits": {},
        # e.g. [{"feature": "observation.state.x", "dim": "z", "range": [0.0, 0.02], "max_frac": 0.05}]
        "dead_zones": [],
        "violation_good": 0.0,  # fraction of frames violating limits
        "violation_bad": 0.05,
        "saturation_run_s": 2.0,  # pinned run longer than this flags SATURATED (action features only)
        "saturation_penalty": 0.0,  # score reduction when SATURATED fires (0 = informational)
        "flag_saturation": False,  # raise SATURATED (an arm resting at the edge of its own range is normal)
        "saturation_skip_patterns": ["hand", "gripper", "finger"],  # open/closed rest at bounds is normal
        "saturation_eps_frac": 0.002,  # |x - extreme| <= eps_frac * range counts as pinned
        "saturation_min_range": 1e-3,
        "features": None,  # features to run saturation detection on; None = all action/state numeric features
    }

    def _dim(self, ep: EpisodeContext, key: str, d) -> int | None:
        names = ep.names(key)
        if isinstance(d, int) or (isinstance(d, str) and d.isdigit()):
            i = int(d)
            return i if 0 <= i < len(names) else None
        return names.index(d) if d in names else None

    def evaluate(self, ep: EpisodeContext):
        dt = 1.0 / ep.fps
        st = signal_start(ep, self.spec)  # zero commands of the pre-roll are not a pinned sensor
        m: dict = {}
        flags: list[str] = []
        ev: list[str] = []
        viol_fracs: list[float] = []

        for key, dims in (self.p("limits") or {}).items():
            if not ep.has(key):
                continue
            arr = ep.array(key)[st:]
            for d, (lo, hi) in dims.items():
                i = self._dim(ep, key, d)
                if i is None:
                    continue
                x = arr[:, i]
                bad = (
                    ((x < lo) | (x > hi))
                    if lo is not None and hi is not None
                    else ((x < lo) if lo is not None else (x > hi))
                )
                frac = float(bad.mean())
                m[f"limit_violation.{key}.{d}"] = frac
                viol_fracs.append(frac)
                if frac > 0:
                    flags.append("LIMIT_VIOLATION")
                    ev.append(
                        f"{key}[{d}] outside [{lo}, {hi}] in {frac * 100:.1f}% of frames (min {x.min():.3f}, max {x.max():.3f})"
                    )

        for dz in self.p("dead_zones") or []:
            key = dz.get("feature")
            if not key or not ep.has(key):
                continue
            i = self._dim(ep, key, dz.get("dim", 0))
            if i is None:
                continue
            lo, hi = dz["range"]
            x = ep.array(key)[st:, i]
            inside = (x >= lo) & (x <= hi)
            frac = float(inside.mean())
            m[f"dead_zone_frac.{key}.{dz.get('dim', 0)}"] = frac
            max_frac = float(dz.get("max_frac", 0.0))
            if frac > max_frac:
                viol_fracs.append(frac - max_frac)
                flags.append("DEAD_ZONE")
                ev.append(
                    f"{key}[{dz.get('dim', 0)}] rests in dead zone [{lo}, {hi}] for {frac * 100:.1f}% of frames"
                )

        feats = self.p("features") or [
            k for k in ep.ds.numeric_keys if k.startswith(("action", "observation.state"))
        ]
        skip = [str(x).lower() for x in (self.p("saturation_skip_patterns") or [])]
        sat_runs = []
        for key in feats:
            if not ep.has(key) or any(x in key.lower() for x in skip):
                continue
            arr = ep.array(key)[st:]
            names = ep.names(key)
            for i in range(arr.shape[1]):
                x = arr[:, i]
                rng = float(np.ptp(x))
                if rng < float(self.p("saturation_min_range")):
                    continue
                eps = rng * float(self.p("saturation_eps_frac"))
                for extreme, tag in ((x.max(), "max"), (x.min(), "min")):
                    pinned = np.abs(x - extreme) <= eps
                    run = longest_run(pinned)
                    if run * dt >= float(self.p("saturation_run_s")) and pinned.mean() > 0.02:
                        # pinned at an extreme for long AND the value is not simply a rest pose:
                        # require that the pinned run is not at the very beginning or end only
                        sat_runs.append((key, names[i], tag, run * dt))
        if sat_runs:
            m["saturation"] = [
                {"feature": k, "dim": n, "at": t, "run_s": round(r, 2)} for k, n, t, r in sat_runs
            ]
            worst = max(r for *_, r in sat_runs)
            m["saturation_run_max_s"] = worst
            # only flag when it's an action (commanded) feature: a state resting at a bound is normal
            act = [r for r in sat_runs if r[0].startswith("action")]
            if act and self.p("flag_saturation"):
                flags.append("SATURATED")
                k, n, t, r = max(act, key=lambda r: r[3])
                ev.append(f"{k}[{n}] pinned at its {t} for {r:.1f}s (clamp?)")

        viol = max(viol_fracs) if viol_fracs else 0.0
        score = ramp(viol, self.p("violation_good"), self.p("violation_bad"))
        if "SATURATED" in flags:
            score = max(0.0, score - float(self.p("saturation_penalty")))
        return self.result(score, m, sorted(set(flags)), ev)
