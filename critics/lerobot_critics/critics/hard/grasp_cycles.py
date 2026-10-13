"""Grasp cycles from the hand/gripper closure signal -> keyframes for vision and VLM."""

from __future__ import annotations

import numpy as np

from ...dataset.features import detect_features
from ...dataset.loader import EpisodeContext
from ..base import HardCritic
from ..registry import register
from ._util import smooth


def closure_signal(ep: EpisodeContext, feature: str, dims: list[int], closed_is_high: bool) -> np.ndarray:
    arr = ep.array(feature)[:, dims]
    sig = arr.mean(axis=1)
    return sig if closed_is_high else -sig


def detect_cycles(
    sig: np.ndarray,
    fps: float,
    min_swing: float | None = None,
    min_hold_s: float = 1.0,
    close_frac: float = 0.45,
    open_frac: float = 0.25,
    merge_gap_s: float = 1.0,
) -> dict:
    """Hysteresis threshold on the smoothed closure signal.

    closed when the signal rises above ``lo + close_frac*swing``, open again when it falls below
    ``lo + open_frac*swing`` (lo/swing from the 2nd/98th percentiles). A close->open pair is a
    grasp; grasps separated by less than ``merge_gap_s`` are merged into one ATTEMPT with a
    ``regrasps`` count (a fumble is not a new attempt). ``hold_s`` is the closed duration.
    """
    s = smooth(sig, max(3, int(fps // 6)))
    lo, hi = float(np.percentile(s, 2)), float(np.percentile(s, 98))
    swing = hi - lo
    if swing < 1e-6 or (min_swing is not None and swing < min_swing):
        return {"n_cycles": 0, "cycles": [], "swing": swing, "closed_frac": 0.0, "regrasps": 0}
    up, down = lo + close_frac * swing, lo + open_frac * swing
    closed = False
    raw = []
    start = None
    for i, v in enumerate(s):
        if not closed and v > up:
            closed, start = True, i
        elif closed and v < down:
            closed = False
            if start is not None and (i - start) / fps >= min_hold_s:
                raw.append([int(start), int(i), 0])
            start = None
    if closed and start is not None and (len(s) - start) / fps >= min_hold_s:
        raw.append([int(start), None, 0])
    merged: list[list] = []
    for g, r, _ in raw:
        if merged and merged[-1][1] is not None and (g - merged[-1][1]) / fps < merge_gap_s:
            merged[-1][1] = r
            merged[-1][2] += 1
        else:
            merged.append([g, r, 0])
    cycles = [
        {"grasp": g, "release": r, "hold_s": ((r if r is not None else len(s)) - g) / fps, "regrasps": k}
        for g, r, k in merged
    ]
    return {
        "n_cycles": len(cycles),
        "cycles": cycles,
        "swing": swing,
        "closed_frac": float((s > lo + 0.5 * swing).mean()),
        "regrasps": int(sum(c["regrasps"] for c in cycles)),
    }


@register
class GraspCyclesCritic(HardCritic):
    id = "grasp_cycles"
    description = (
        "Counts close->open cycles of the hand/gripper (hysteresis on the smoothed closure signal) and derives "
        "grasp/release keyframes. Scores against task.expected_cycles when set, otherwise requires >= 1 grasp. "
        "Also reports hold durations, an unfinished grasp at episode end, and the grasp profile per cycle: how long "
        "the closing took, how far the wrist moved while closing, how long it had settled before closing, the gaps "
        "between cycles and the share of the episode with the arm actually moving."
    )
    default_params = {
        "min_hold_s": 1.0,  # shorter closures are twitches, not grasps
        "close_frac": 0.45,  # closure above lo + close_frac*swing = closed
        "open_frac": 0.25,  # closure below lo + open_frac*swing = open again
        "merge_gap_s": 1.0,  # re-grasp within this gap = same attempt (counted in 'regrasps')
        "expected_cycles": None,  # overrides task.expected_cycles
        "tolerance": 0,  # accepted |n - expected| without penalty
        "unfinished_penalty": 0.3,
        "regrasp_penalty": 0.1,  # per re-grasp
        # a closure only counts as a task attempt when the arm carries the object: the wrist must move
        # at least this far (m for cartesian arms, fraction of range for joint arms) while closed.
        # Idle closures (operator squeezing while waiting) are reported as 'idle_closures'.
        "min_carry_m": 0.05,
        "min_carry_norm": 0.05,
        "close_search_s": 3.0,  # window before/after a grasp keyframe in which the closing profile is measured
    }

    def _carry(self, ep: EpisodeContext, rf, g: int, r: int | None) -> float | None:
        """Max wrist displacement from the grasp pose during the hold (m or normalized)."""
        pairs = [p for p in rf.active_pairs if p.kind == "cartesian"] or [
            p for p in rf.pairs if p.kind == "cartesian"
        ]
        joints = [p for p in rf.active_pairs if p.kind == "joints"] or [
            p for p in rf.pairs if p.kind == "joints"
        ]
        end = r if r is not None else ep.length
        best = None
        for p in pairs:
            if any(x in p.state.lower() for x in ("elbow",)):
                continue
            pos = ep.array(p.state)[g:end, :3]
            if len(pos) < 2:
                continue
            d = float(np.linalg.norm(pos - pos[0], axis=1).max())
            best = d if best is None else max(best, d)
        if best is not None:
            return best
        for p in joints:
            s = ep.array(p.state)
            rng = np.maximum(np.ptp(s, axis=0), 1e-9)
            seg = s[g:end] / rng
            if len(seg) < 2:
                continue
            d = float(np.abs(seg - seg[0]).max())
            best = d if best is None else max(best, d)
        return best

    def _grasp_profile(self, ep: EpisodeContext, rf, g, cycles: list[dict]) -> dict:
        """Per-cycle closing duration, wrist motion while closing, settle time before closing,
        gaps between cycles, and the active share of the episode (from the commanded wrist)."""
        out: dict = {}
        fps = ep.fps
        # closure command when available (operator intent), else the state
        feat = g.action_feature if g.action_feature and ep.has(g.action_feature) else g.feature
        sig = closure_signal(ep, feat, g.dims, g.closed_is_high)
        lo, hi = float(np.percentile(sig, 2)), float(np.percentile(sig, 98))
        swing = hi - lo
        pairs = [p for p in rf.active_pairs if p.kind == "cartesian" and "elbow" not in p.state.lower()] or [
            p for p in rf.pairs if p.kind == "cartesian" and "elbow" not in p.state.lower()
        ]
        pos = ep.array(pairs[0].state)[:, :3] if pairs and ep.has(pairs[0].state) else None
        cmd = ep.array(pairs[0].action)[:, :3] if pairs and ep.has(pairs[0].action) else pos
        if cmd is not None:
            speed = np.concatenate([[0.0], np.linalg.norm(np.diff(cmd, axis=0), axis=1) * fps])
            out["active_frac"] = float((speed > 0.02).mean())
        if swing < 1e-6 or not cycles:
            return out
        close_dur, wrist_move, settle = [], [], []
        n = len(sig)
        win = max(2, int(round(float(self.p("close_search_s")) * fps)))
        for c in cycles:
            e = int(c["grasp"])
            # closing starts where the signal leaves the open plateau (15 % of the swing above the most
            # open point) in the window before the grasp keyframe ...
            w0 = max(0, e - win)
            floor = float(sig[w0 : e + 1].min())
            a = e
            while a > w0 and sig[a - 1] > floor + 0.15 * swing:
                a -= 1
            while a > w0 and sig[a - 1] <= floor + 0.15 * swing and sig[a] <= floor + 0.15 * swing:
                a -= 1
            # a now sits on the last open-plateau frame before the rise; step to the first rising frame
            while a < e and sig[a] <= floor + 0.15 * swing:
                a += 1
            a = max(w0, a - 1)
            # ... and ends when the signal first reaches 85 % of its swing (bounded search)
            b = e
            while b < min(n - 1, e + win) and sig[b] < hi - 0.15 * swing:
                b += 1
            close_dur.append(round((b - a) / fps, 2))
            if pos is not None and np.abs(pos[a]).sum() > 0 and np.abs(pos[b]).sum() > 0:
                wrist_move.append(round(float(np.linalg.norm(pos[b] - pos[a]) * 1000.0), 1))
            if cmd is not None:
                d = a
                while d > 0 and speed[d] < 0.03:
                    d -= 1
                settle.append(round((a - d) / fps, 2))
        out["close_dur_s"] = close_dur
        out["close_dur_median_s"] = float(np.median(close_dur)) if close_dur else None
        if wrist_move:
            out["wrist_move_during_close_mm"] = wrist_move
            out["wrist_move_during_close_median_mm"] = float(np.median(wrist_move))
        if settle:
            out["settle_before_close_s"] = settle
            out["settle_before_close_median_s"] = float(np.median(settle))
        gaps = [
            round((cycles[i + 1]["grasp"] - cycles[i]["release"]) / fps, 2)
            for i in range(len(cycles) - 1)
            if cycles[i].get("release") is not None
        ]
        if gaps:
            out["cycle_gap_s"] = gaps
        return out

    def evaluate(self, ep: EpisodeContext):
        rf = ep.cache.get("features") or detect_features(ep.ds, self.spec, ep)
        ep.cache["features"] = rf
        g = rf.gripper
        if g is None or not ep.has(g.feature):
            return self.result(None, error="no gripper/hand signal detected (set robot.gripper.feature)")
        sig = closure_signal(ep, g.feature, g.dims, g.closed_is_high)
        det = detect_cycles(
            sig,
            ep.fps,
            self.spec.robot.gripper.min_swing,
            float(self.p("min_hold_s")),
            float(self.p("close_frac")),
            float(self.p("open_frac")),
            float(self.p("merge_gap_s")),
        )
        # drop closures without a carry (the arm did not move the object anywhere)
        cart = any(p.kind == "cartesian" for p in rf.pairs)
        thr = float(self.p("min_carry_m")) if cart else float(self.p("min_carry_norm"))
        kept, idle = [], []
        for c in det["cycles"]:
            carry = self._carry(ep, rf, c["grasp"], c["release"])
            c["carry"] = carry
            (kept if carry is None or carry >= thr else idle).append(c)
        det["cycles"] = kept
        det["n_cycles"] = len(kept)
        det["idle_closures"] = len(idle)
        det["regrasps"] = int(sum(c["regrasps"] for c in kept))
        ep.cache["grasp_cycles"] = det
        profile = self._grasp_profile(ep, rf, g, det["cycles"])
        n = det["n_cycles"]
        expected = self.p("expected_cycles") or self.spec.task.expected_cycles
        m = {
            "n_cycles": n,
            "expected_cycles": expected,
            "gripper_feature": g.feature,
            "swing": det["swing"],
            "closed_frac": det["closed_frac"],
            "hold_s": [round(c["hold_s"], 2) for c in det["cycles"]],
            "grasp_frames": [c["grasp"] for c in det["cycles"]],
            "release_frames": [c["release"] for c in det["cycles"]],
            "regrasps": det.get("regrasps", 0),
            "idle_closures": det.get("idle_closures", 0),
            "carry": [None if c.get("carry") is None else round(c["carry"], 3) for c in det["cycles"]],
            **profile,
        }
        flags, ev = [], []
        # A trailing closed segment that never reopens only means the *episode* failed if nothing
        # was ever released before it - a real release earlier in the episode (task done, gripper
        # then closed empty on its way to idle/retreat) is not a failure of that attempt.
        unfinished = (
            bool(det["cycles"])
            and det["cycles"][-1]["release"] is None
            and not any(c["release"] is not None for c in det["cycles"][:-1])
        )
        if n == 0:
            flags.append("NOGRASP")
            ev.append("gripper never closed on anything")
            return self.result(0.0, m, flags, ev)
        if expected:
            dev = max(0, abs(n - expected) - int(self.p("tolerance")))
            score = max(0.0, 1.0 - dev / max(expected, 1))
            if n != expected:
                flags.append("CYCLE_COUNT")
                ev.append(f"{n} grasp cycles, expected {expected}")
        else:
            score = 1.0
            if n > 1:
                flags.append("MULTIGRASP")
                ev.append(f"{n} grasp cycles (re-grasp / retry?)")
        if det.get("regrasps"):
            flags.append("REGRASP")
            ev.append(f"{det['regrasps']} re-grasp(s) within an attempt")
            score = max(0.0, score - float(self.p("regrasp_penalty")) * det["regrasps"])
        if unfinished:
            flags.append("UNFINISHED_GRASP")
            ev.append("episode ends with the object still held")
            score = max(0.0, score - float(self.p("unfinished_penalty")))
        return self.result(score, m, flags, ev)
