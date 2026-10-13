"""Tracking error between leader command (action) and follower readback (state)."""

from __future__ import annotations

import numpy as np

from ...dataset.features import detect_features
from ...dataset.loader import EpisodeContext
from ...dataset.preroll import signal_start
from ..base import HardCritic, ramp
from ..registry import register
from ._util import orientation_error_deg, runs, xcorr_lag


def _lag_frames(a: np.ndarray, s: np.ndarray, max_lag: int) -> int | None:
    """Follower lag in frames: the shift of state that minimises the mean |action - state|.

    A positive lag is only accepted when it reduces the error by at least 10 % relative to
    zero lag, so noisy but well-aligned signals report 0 rather than a random shift.
    """
    n = len(a)
    max_lag = int(min(max_lag, max(n // 4, 1)))
    if n < 8 or np.ptp(a, axis=0).max() < 1e-9:
        return None
    errs = []
    for lag in range(0, max_lag + 1):
        e = (
            np.linalg.norm(a[: n - lag] - s[lag:], axis=1).mean()
            if lag
            else np.linalg.norm(a - s, axis=1).mean()
        )
        errs.append(float(e))
    best = int(np.argmin(errs))
    if best > 0 and errs[best] > 0.9 * errs[0]:
        return 0
    return best


@register
class TrackingErrorCritic(HardCritic):
    id = "tracking_error"
    description = (
        "|action - state| per arm: cartesian position error in mm (mean, p95), orientation error in degrees, "
        "hand/gripper error, follower lag (integer frames from the error minimum, plus a sub-frame estimate in ms "
        "from the cross-correlation of command and state velocities with its correlation peak, and the share of the "
        "raw error that is pure latency), and the longest span where the follower did not follow at all. Position "
        "error is scored after lag compensation so a normal 200 ms teleop latency is reported as lag, not as error. "
        "Score uses the active arms; other arms only produce flags."
    )
    default_params = {
        # features whose key matches one of these substrings are reported but never scored
        # (e.g. elbow "poses" on humanoids are redundancy hints, not tracked targets)
        "exclude_patterns": ["elbow"],
        "lag_compensate": True,  # score the error after shifting state by the estimated lag
        "pos_good_mm": 8.0,
        "pos_bad_mm": 40.0,
        "rot_good_deg": 3.0,
        "rot_bad_deg": 20.0,
        "joint_good": 0.02,  # normalized (by range) per-joint mean error
        "joint_bad": 0.15,
        "hand_good": 0.05,  # normalized by hand range
        "hand_bad": 0.4,
        "max_lag_frames": 45,
        "lag_good": 6,
        "lag_bad": 25,
        "latency_good_ms": 100.0,  # session-profile thresholds for the cross-correlation latency (report only)
        "latency_bad_ms": 300.0,
        "stall_mm": 30.0,  # error above this for a long span = follower not following
        "stall_bad_s": 3.0,
        "inactive_arm_flag_mm": 25.0,
        "inactive_arm_relax": 3.0,  # inactive arms are scored with thresholds multiplied by this
    }
    relative_flags = {"pos_err_mean_mm": ("TRACKERR_OUTLIER", +1)}

    def evaluate(self, ep: EpisodeContext):
        rf = ep.cache.get("features") or detect_features(ep.ds, self.spec, ep)
        ep.cache["features"] = rf
        if not rf.pairs:
            return self.result(None, error="no action/state pairs")
        st = signal_start(ep, self.spec, rf)  # measure from the first real command
        dt = 1.0 / ep.fps
        m: dict = {}
        flags: list[str] = []
        ev: list[str] = []
        scores: list[float] = []
        active_pos_err: list[float] = []
        excl = [str(x).lower() for x in (self.p("exclude_patterns") or [])]
        for p in rf.pairs:
            a, s = ep.array(p.action)[st:], ep.array(p.state)[st:]
            if a.shape != s.shape:
                continue
            tag = p.action
            scored = not any(x in tag.lower() for x in excl)
            relax = 1.0 if p.active else float(self.p("inactive_arm_relax"))
            part_scores: list[float] = []
            if p.kind == "cartesian":
                e_raw = np.linalg.norm(a[:, :3] - s[:, :3], axis=1) * 1000.0
                m[f"pos_err_raw_mean_mm.{tag}"] = float(e_raw.mean())
                lag = _lag_frames(a[:, :3], s[:, :3], int(self.p("max_lag_frames")))
                L = lag if (lag and self.p("lag_compensate")) else 0
                a_c, s_c = (a[: len(a) - L], s[L:]) if L else (a, s)
                e = np.linalg.norm(a_c[:, :3] - s_c[:, :3], axis=1) * 1000.0
                mean_mm, p95_mm = float(e.mean()), float(np.percentile(e, 95))
                m[f"pos_err_mean_mm.{tag}"] = mean_mm
                m[f"pos_err_p95_mm.{tag}"] = p95_mm
                raw_mean = float(e_raw.mean())
                if raw_mean > 1e-9:
                    m[f"lag_err_share.{tag}"] = float(max(0.0, 1.0 - mean_mm / raw_mean))
                # sub-frame latency from the cross-correlation of the 3-D speed profiles
                ok = (np.abs(a[:, :3]).sum(1) > 0) & (np.abs(s[:, :3]).sum(1) > 0)
                if ok.sum() > 32:
                    va = np.linalg.norm(np.diff(a[ok, :3], axis=0), axis=1)
                    vs = np.linalg.norm(np.diff(s[ok, :3], axis=0), axis=1)
                    xl = xcorr_lag(va, vs, int(self.p("max_lag_frames")))
                    if xl is not None:
                        m[f"lag_xcorr_frames.{tag}"] = xl[0]
                        m[f"lag_ms.{tag}"] = xl[0] / ep.fps * 1000.0
                        m[f"lag_corr.{tag}"] = xl[1]
                part_scores.append(ramp(mean_mm, self.p("pos_good_mm") * relax, self.p("pos_bad_mm") * relax))
                stall = runs(e > float(self.p("stall_mm")) * relax)
                stall_s = max((b - a0 for a0, b in stall), default=0) * dt
                m[f"stall_s.{tag}"] = stall_s
                part_scores.append(ramp(stall_s, self.p("stall_bad_s") * 0.3, self.p("stall_bad_s")))
                rot = orientation_error_deg(a_c, s_c)
                if rot is not None:
                    rot_mean = float(np.nanmean(rot))
                    m[f"rot_err_mean_deg.{tag}"] = rot_mean
                    part_scores.append(
                        ramp(rot_mean, self.p("rot_good_deg") * relax, self.p("rot_bad_deg") * relax)
                    )
                if lag is not None and p.active:
                    m[f"lag_frames.{tag}"] = lag
                    part_scores.append(ramp(lag, self.p("lag_good"), self.p("lag_bad")))
                if not scored:
                    continue
                if p.active:
                    active_pos_err.append(mean_mm)
                    if mean_mm > float(self.p("pos_bad_mm")) or stall_s > float(self.p("stall_bad_s")):
                        flags.append("TRACKERR")
                        ev.append(
                            f"{p.arm or tag}: mean position error {mean_mm:.1f} mm (lag-compensated), not following for {stall_s:.1f}s"
                        )
                elif mean_mm > float(self.p("inactive_arm_flag_mm")):
                    flags.append("INACTIVE_ARM_TRACKERR")
                    ev.append(
                        f"inactive arm {p.arm or tag}: mean position error {mean_mm:.1f} mm although it should be idle"
                    )
            elif p.kind == "hand":
                rng = float(np.ptp(np.concatenate([a, s]), axis=0).max()) or 1.0
                e = float(np.abs(a - s).mean() / rng)
                m[f"hand_err_norm.{tag}"] = e
                part_scores.append(ramp(e, self.p("hand_good"), self.p("hand_bad")))
            else:
                rng = np.ptp(np.concatenate([a, s]), axis=0)
                keep = rng > 1e-9
                if not keep.any():
                    continue
                e = np.abs(a[:, keep] - s[:, keep]) / rng[keep]
                per = e.mean(0)
                m[f"joint_err_norm_mean.{tag}"] = float(per.mean())
                m[f"joint_err_norm_worst.{tag}"] = float(per.max())
                part_scores.append(ramp(float(per.max()), self.p("joint_good"), self.p("joint_bad")))
                lag = _lag_frames(a[:, keep], s[:, keep], int(self.p("max_lag_frames")))
                if lag is not None:
                    m[f"lag_frames.{tag}"] = lag
                    part_scores.append(ramp(lag, self.p("lag_good"), self.p("lag_bad")))
                if p.active and float(per.max()) > float(self.p("joint_bad")):
                    flags.append("TRACKERR")
                    ev.append(f"{tag}: worst joint normalized error {per.max():.2f}")
            if part_scores and scored:
                scores.append(float(np.mean(part_scores)))
        if not scores:
            return self.result(None, m, error="no active arm to score")
        m["pos_err_mean_mm"] = max(active_pos_err) if active_pos_err else None
        lags = [
            v
            for k, v in m.items()
            if k.startswith("lag_ms.")
            and isinstance(v, (int, float))
            and any(p.action == k[7:] and p.active for p in rf.pairs)
        ]
        m["lag_ms"] = max(lags) if lags else None
        if lags:
            slowest = max(
                (k[7:] for k, v in m.items() if k.startswith("lag_ms.") and v == m["lag_ms"]), default=None
            )
            m["lag_err_share"] = m.get(f"lag_err_share.{slowest}") if slowest else None
        return self.result(min(scores), m, sorted(set(flags)), ev)
