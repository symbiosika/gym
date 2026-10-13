"""Spatial diversity of the demonstrations (dataset level).

A policy only learns to *correct* towards an object if the object was in different places
during recording. On a long-horizon cup->tray dataset the wrist position at the 151 grasps had a
standard deviation of ~1 cm: the approach could be replayed from memory, the grasp could not
be corrected. This critic collects the grasp / release / start positions per episode and
reports their spread across the run. It is informational (weight 0 by default): it never
changes an episode's verdict, but the run summary raises LOW_DIVERSITY when every grasp
happened at practically the same spot.
"""

from __future__ import annotations

import numpy as np

from ...dataset.features import detect_features
from ...dataset.loader import EpisodeContext
from ..base import CriticResult, HardCritic
from ..registry import register
from .grasp_cycles import closure_signal, detect_cycles


@register
class DiversityCritic(HardCritic):
    id = "diversity"
    description = (
        "Spatial diversity of the demonstrations: wrist position of the active arm at every grasp and release "
        "keyframe and at the episode start, and (dataset level) their standard deviation and range across the run. "
        "A run whose grasps all lie within ~1 cm teaches the policy a fixed trajectory, not a visually guided grasp. "
        "Informational: weight 0 by default, the LOW_DIVERSITY flag lives in the run summary."
    )
    default_params = {
        "low_std_cm": 3.0,  # LOW_DIVERSITY when the robust horizontal grasp-position spread is below this
        "grasp_offset_frames": 0,  # sample the wrist this many frames after the grasp keyframe
    }

    def _wrist_pair(self, rf):
        pairs = [p for p in rf.active_pairs if p.kind == "cartesian"] or [
            p for p in rf.pairs if p.kind == "cartesian"
        ]
        pairs = [p for p in pairs if "elbow" not in p.state.lower()]
        return pairs[0] if pairs else None

    def evaluate(self, ep: EpisodeContext):
        rf = ep.cache.get("features") or detect_features(ep.ds, self.spec, ep)
        ep.cache["features"] = rf
        p = self._wrist_pair(rf)
        if p is None or not ep.has(p.state):
            return self.result(None, error="no cartesian wrist state (diversity needs xyz)")
        s = ep.array(p.state)[:, :3]
        gc = ep.cache.get("grasp_cycles")
        if gc is None and rf.gripper is not None and ep.has(rf.gripper.feature):
            sig = closure_signal(ep, rf.gripper.feature, rf.gripper.dims, rf.gripper.closed_is_high)
            gc = detect_cycles(sig, ep.fps, self.spec.robot.gripper.min_swing)
        cycles = (gc or {}).get("cycles", [])
        off = int(self.p("grasp_offset_frames"))
        n = len(s)

        def _at(i):
            j = int(min(max(i, 0), n - 1))
            v = s[j]
            return None if np.abs(v).sum() == 0 else [round(float(x), 4) for x in v]

        grasp = [_at(c["grasp"] + off) for c in cycles if c.get("grasp") is not None]
        release = [_at(c["release"]) for c in cycles if c.get("release") is not None]
        m = {
            "wrist_feature": p.state,
            "n_grasps": len([g for g in grasp if g]),
            "grasp_pos_m": [g for g in grasp if g],
            "release_pos_m": [r for r in release if r],
            "start_pos_m": _at(0),
            "end_pos_m": _at(n - 1),
        }
        return self.result(None, m)

    def finalize(self, results: list[CriticResult], z_cut: float) -> None:
        pts = np.array([g for r in results for g in (r.metrics.get("grasp_pos_m") or [])], float)
        if len(pts) < 2:
            return
        med = np.median(pts, axis=0)
        for r in results:
            g = np.array(r.metrics.get("grasp_pos_m") or [], float)
            if len(g):
                r.metrics["grasp_offset_from_median_cm"] = float(
                    np.linalg.norm(g - med, axis=1).max() * 100.0
                )

    def summarize(self, results: list[CriticResult]) -> dict | None:
        def _spread(key: str) -> dict | None:
            pts = np.array([g for r in results for g in (r.metrics.get(key) or [])], float)
            if len(pts) < 2:
                return None
            med = np.median(pts, 0)
            robust = 1.4826 * np.median(np.abs(pts - med), axis=0)
            return {
                "n": int(len(pts)),
                "std_cm": [round(float(x), 2) for x in pts.std(0) * 100],
                "robust_std_cm": [round(float(x), 2) for x in robust * 100],
                "range_cm": [round(float(x), 2) for x in np.ptp(pts, axis=0) * 100],
                "median_m": [round(float(x), 4) for x in med],
            }

        starts = np.array([r.metrics["start_pos_m"] for r in results if r.metrics.get("start_pos_m")], float)
        out: dict = {}
        g = _spread("grasp_pos_m")
        rel = _spread("release_pos_m")
        if g:
            out["grasp_positions"] = g
        if rel:
            out["release_positions"] = rel
        if len(starts) > 1:
            out["start_pose_std_cm"] = [round(float(x), 2) for x in starts.std(0) * 100]
        flags: dict[str, str] = {}
        if g:
            rs = g["robust_std_cm"]
            horiz = max(rs[:2]) if len(rs) >= 2 else rs[0]
            out["grasp_horizontal_spread_cm"] = horiz
            if horiz < float(self.p("low_std_cm")):
                flags["LOW_DIVERSITY"] = (
                    f"{g['n']} grasps but the object position varied by only {rs[0]} / {rs[1]} cm "
                    f"(robust std x / y; plain std {g['std_cm'][0]} / {g['std_cm'][1]} cm, range "
                    f"{g['range_cm'][0]} / {g['range_cm'][1]} cm). The policy can replay the approach from memory but "
                    "never sees a correction towards the object. Randomise the object position over the workspace in "
                    "the next recording session."
                )
        out["flags"] = flags
        return out if (g or rel or len(starts) > 1) else None
