"""Motion smoothness of the demonstration (from the commanded action = operator intent)."""

from __future__ import annotations

import numpy as np

from ...dataset.features import detect_features
from ...dataset.loader import EpisodeContext
from ...dataset.preroll import signal_start
from ..base import HardCritic, ramp, ramp_high
from ..registry import register
from ._util import high_freq_ratio, longest_run, windowed_ldj


@register
class SmoothnessCritic(HardCritic):
    id = "smoothness"
    description = (
        "How fluid the demonstrated motion is. For cartesian arms: windowed log-dimensionless-jerk (median over "
        "3 s windows with motion), high-frequency energy ratio of the speed profile, jerk spikes (single-frame "
        "action jumps far above the episode's typical step) and hesitation (longest still span mid-episode)."
    )
    default_params = {
        "window_s": 3.0,
        "ldj_good": -15.5,  # windowed (3 s) LDJ at or above this -> full score; fluid cartesian teleop ~ -14..-15
        "ldj_bad": -18.5,  # at or below -> 0
        "hf_cutoff_hz": 2.5,
        "hf_good": 0.08,  # fraction of speed-profile energy above the cutoff (tremor / noise)
        "hf_bad": 0.30,
        # a "spike" is a physically implausible single-frame event in the COMMAND: acceleration above
        # spike_accel_mps2 (m/s^2) or speed above spike_speed_mps (m/s) for cartesian features; for
        # joint features a per-frame step above spike_norm_step of the joint's range.
        "spike_accel_mps2": 25.0,
        "spike_speed_mps": 1.0,
        "spike_norm_step": 0.10,
        "spike_rate_good": 0.0,  # spikes per minute
        "spike_rate_bad": 3.0,
        "still_eps": 1e-4,  # per-frame action change (m or units) below this = still
        "hesitation_bad_s": 8.0,  # longest still span inside the motion -> 0 score at this
        "min_speed": 0.02,  # m/s window must exceed to count for LDJ
    }
    relative_flags = {"neg_ldj_median": ("JERKY_OUTLIER", +1), "hf_ratio": ("JERKY_OUTLIER", +1)}

    def evaluate(self, ep: EpisodeContext):
        rf = ep.cache.get("features") or detect_features(ep.ds, self.spec, ep)
        ep.cache["features"] = rf
        dt = 1.0 / ep.fps
        pairs = [p for p in rf.active_pairs if p.kind in ("cartesian", "joints")] or [
            p for p in rf.pairs if p.kind in ("cartesian", "joints")
        ]
        if not pairs:
            return self.result(None, error="no arm action/state feature found")
        st = signal_start(ep, self.spec, rf)  # the jump out of the pre-roll is not a spike
        m: dict = {}
        ldjs: list[float] = []
        hfs: list[float] = []
        spikes = 0
        stills: list[int] = []
        speeds: list[float] = []
        for p in pairs:
            a = ep.array(p.action)[st:]
            if p.kind == "cartesian":
                pos = a[:, :3]
            else:
                rng = np.ptp(a, axis=0)
                keep = rng > 1e-6
                if not keep.any():
                    continue
                pos = a[:, keep] / rng[keep]
            v = np.linalg.norm(np.gradient(pos, dt, axis=0), axis=1)
            if v.max() < 1e-6:
                continue
            speeds.append(float(np.percentile(v, 95)))
            w = windowed_ldj(pos, dt, float(self.p("window_s")), float(self.p("min_speed")))
            if w:
                ldjs.append(float(np.median(w)))
                m[f"ldj_median.{p.action}"] = float(np.median(w))
            hf = high_freq_ratio(v, ep.fps, float(self.p("hf_cutoff_hz")))
            if hf is not None:
                hfs.append(hf)
                m[f"hf_ratio.{p.action}"] = hf
            steps = np.linalg.norm(np.diff(pos, axis=0), axis=1)
            if p.kind == "cartesian":
                acc = np.linalg.norm(np.diff(pos, n=2, axis=0), axis=1) / dt**2
                sp = int(
                    (
                        (acc > float(self.p("spike_accel_mps2")))
                        | (steps[1:] / dt > float(self.p("spike_speed_mps")))
                    ).sum()
                )
                m[f"accel_max.{p.action}"] = float(acc.max())
            else:
                sp = int((steps > float(self.p("spike_norm_step"))).sum())
            spikes += sp
            m[f"spikes.{p.action}"] = sp
            moving = steps > float(self.p("still_eps"))
            if moving.any():
                first, last = int(np.argmax(moving)), len(moving) - int(np.argmax(moving[::-1]))
                stills.append(longest_run(~moving[first:last]))
        if not ldjs and not hfs:
            return self.result(None, error="arm never moved")
        ldj_med = float(np.median(ldjs)) if ldjs else None
        hf_med = float(np.median(hfs)) if hfs else None
        spike_rate = spikes / max((ep.length - st) / ep.fps / 60.0, 1e-6)
        hes_s = max(stills) * dt if stills else 0.0
        m.update(
            {
                "ldj_median": ldj_med,
                "neg_ldj_median": -ldj_med if ldj_med is not None else None,
                "hf_ratio": hf_med,
                "spikes": spikes,
                "spike_rate_per_min": spike_rate,
                "hesitation_s": hes_s,
                "speed_p95": max(speeds) if speeds else None,
            }
        )
        parts = []
        if ldj_med is not None:
            parts.append(ramp_high(ldj_med, float(self.p("ldj_good")), float(self.p("ldj_bad"))))
        if hf_med is not None:
            parts.append(ramp(hf_med, float(self.p("hf_good")), float(self.p("hf_bad"))))
        parts.append(ramp(spike_rate, float(self.p("spike_rate_good")), float(self.p("spike_rate_bad"))))
        parts.append(ramp(hes_s, float(self.p("hesitation_bad_s")) * 0.5, float(self.p("hesitation_bad_s"))))
        score = float(np.mean([x for x in parts if x is not None]))
        flags, ev = [], []
        if ldj_med is not None and ldj_med < float(self.p("ldj_bad")):
            flags.append("JERKY")
            ev.append(f"windowed LDJ {ldj_med:.1f} below {self.p('ldj_bad')}")
        if spike_rate > float(self.p("spike_rate_bad")):
            flags.append("ACTION_SPIKES")
            ev.append(f"{spikes} single-frame action jumps ({spike_rate:.1f}/min)")
        if hes_s > float(self.p("hesitation_bad_s")):
            flags.append("HESITATION")
            ev.append(f"operator paused {hes_s:.1f}s mid-episode")
        return self.result(score, m, flags, ev)
