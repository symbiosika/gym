"""Spatial diversity of the demonstrations (dataset level).

A policy only learns to *correct* towards an object if the object was in different places
during recording. On a long-horizon cup->tray dataset the wrist position at the 151 grasps had a
standard deviation of ~1 cm: the approach could be replayed from memory, the grasp could not
be corrected. This critic collects the grasp / release / start positions per episode and
reports their spread across the run. It is informational (weight 0 by default): it never
changes an episode's verdict, but the run summary raises LOW_DIVERSITY when every grasp
happened at practically the same spot.

Each episode also carries ``cue_features``: the robot state in its first and last frame, a
small picture of the scene camera's first frame and a colour signature of what it picked.
They feed the shortcut figures (``lerobot_critics.shortcuts``): over this run in the run
summary (``shortcuts``), and over any selection of runs through ``POST /analyses/shortcuts``.
"""

from __future__ import annotations

import numpy as np

from ...dataset.features import arm_grippers, arm_wrist_pairs, detect_features, gripper_arm_pair
from ...dataset.loader import EpisodeContext
from ...dataset.scan import scan_episode
from ...shortcuts import analyse, centre_signature, changed_signature, episode_from, thumbnail
from ..base import CriticResult, HardCritic
from ..registry import register
from .grasp_cycles import closure_signal, detect_cycles

# a hand whose closure swings less than this share of the busiest hand's in the episode is resting
RESTING_HAND_SWING_FRAC = 0.25


def _pos(s: np.ndarray, i: int) -> list[float] | None:
    """The position in row ``i``, clamped to the episode; None for an all-zero row (a dropout)."""
    v = s[int(min(max(i, 0), len(s) - 1))]
    return None if np.abs(v).sum() == 0 else [round(float(x), 4) for x in v]


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
        "cue_features": True,  # off: no first-frame picture, state or colour signature per episode
    }

    def _wrist_pair(self, rf):
        return gripper_arm_pair(rf)

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
        m.update(self._per_arm(ep, rf, off))
        if self.p("cue_features"):
            try:
                m["cue_features"] = self._cue_features(ep, rf, m.get("grasp_arm"))
            except Exception as e:  # noqa: BLE001 - the figures above stand without it
                m["cue_features"] = {"prompt": ep.task, "error": f"{type(e).__name__}: {e}"}
        return self.result(None, m)

    def _cue_features(self, ep: EpisodeContext, rf, grasp_arm: str | None) -> dict:
        """What the shortcut figures read of this episode (see ``lerobot_critics.shortcuts``)."""
        out: dict = {"prompt": ep.task}
        keys = [k for k in ep.ds.numeric_keys if k.startswith("observation.state") and ep.has(k)]
        if keys:
            arrs = [ep.array(k) for k in keys]
            n = min(len(a) for a in arrs)
            # a dropout zeroes a whole feature for a frame: start and end are the first and last
            # frame where every state feature carries a value
            ok = np.ones(n, bool)
            for a in arrs:
                ok &= np.abs(a[:n]).sum(1) > 0
            if ok.any():
                i0 = int(np.argmax(ok))
                i1 = n - 1 - int(np.argmax(ok[::-1]))
                out["state_keys"] = keys
                out["start_state"] = [round(float(v), 4) for a in arrs for v in a[i0]]
                out["end_state"] = [round(float(v), 4) for a in arrs for v in a[i1]]
        cams = ep.cameras
        if not cams:
            return out
        scan = scan_episode(ep)
        scene = rf.primary_camera if rf.primary_camera in scan else None
        first = last = None
        if scene:
            first, last = scan[scene].get("first_rgb"), scan[scene].get("last_rgb")
            if first is not None:
                out["thumb"] = {"camera": scene, "rgb": thumbnail(first)}
        wrist = [c for c in rf.wrist_cameras if c in scan]
        mine = [c for c in wrist if rf.camera_arms.get(c) == grasp_arm] if grasp_arm else []
        hand_cam = mine[0] if mine else (wrist[0] if len(wrist) == 1 else None)
        parts: list[str] = []
        look: list[float] = []
        if scene:
            sig = changed_signature(first, last)
            if sig is None:
                return out
            parts.append(f"changed:{scene}")
            look += sig
        if wrist:
            sig = centre_signature(scan[hand_cam].get("last_rgb")) if hand_cam else None
            if sig is None:
                return out
            parts.append("in_hand")
            look += sig
        if look:
            out["look"] = look
            out["look_parts"] = parts
        return out

    def _per_arm(self, ep: EpisodeContext, rf, off: int) -> dict:
        """Where every arm was and which one grasped, whatever the spec calls active.

        The figures above follow the spec's arm and the grasp_cycles critic; on a robot whose
        arms take turns from episode to episode that is one arm for the whole run. These keys
        are read per episode instead: each arm's wrist at the start and the end, each arm's own
        grasps from its own hand, and the arm that grasped. Informational like the rest.
        """
        wrists: dict[str, dict] = {}
        xyz: dict[str, np.ndarray] = {}
        for arm, pair in arm_wrist_pairs(rf).items():
            if not ep.has(pair.state):
                continue
            s = ep.array(pair.state)[:, :3]
            xyz[arm] = s
            wrists[arm] = {"start_pos_m": _pos(s, 0), "end_pos_m": _pos(s, len(s) - 1)}
        found: dict[str, dict] = {}
        for arm, grip in arm_grippers(ep.ds, rf).items():
            if arm not in xyz or not ep.has(grip.feature):
                continue
            sig = closure_signal(ep, grip.feature, grip.dims, grip.closed_is_high)
            found[arm] = detect_cycles(sig, ep.fps, self.spec.robot.gripper.min_swing)
        # a resting hand drifts a little, and a drift is a full swing to a detector that scales
        # to what it sees: only a hand that closes about as far as the busiest one has grasped
        widest = max((c["swing"] for c in found.values()), default=0.0)
        by_arm: dict[str, dict] = {}
        swing: dict[str, float] = {}
        for arm, c in found.items():
            cycles = c["cycles"] if widest > 0 and c["swing"] >= RESTING_HAND_SWING_FRAC * widest else []
            s = xyz[arm]
            grasp = [_pos(s, k["grasp"] + off) for k in cycles if k.get("grasp") is not None]
            release = [_pos(s, k["release"]) for k in cycles if k.get("release") is not None]
            by_arm[arm] = {"grasp_pos_m": [g for g in grasp if g], "release_pos_m": [r for r in release if r]}
            swing[arm] = float(c["swing"])
        grasped = [a for a in by_arm if by_arm[a]["grasp_pos_m"]]
        grasp_arm = max(grasped, key=lambda a: (len(by_arm[a]["grasp_pos_m"]), swing[a])) if grasped else None
        return {"wrists": wrists, "grasps_by_arm": by_arm, "grasp_arm": grasp_arm}

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
        short = self._shortcuts(results)
        if short:
            flags.update(short.pop("flags", {}))
            out["shortcuts"] = short
        out["flags"] = flags
        return out if (g or rel or len(starts) > 1 or short) else None

    def _shortcuts(self, results: list[CriticResult]) -> dict | None:
        """The shortcut figures over this run alone (a selection of runs: POST /analyses/shortcuts)."""
        eps = [episode_from(r.metrics, str(i), "", i) for i, r in enumerate(results)]
        if not any(e.start is not None or e.thumb is not None for e in eps):
            return None
        return analyse(eps)
