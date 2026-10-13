"""Duplication / lag: repeated camera images and frozen action/state rows."""

from __future__ import annotations

import numpy as np

from ...dataset.features import _arm_of, detect_features
from ...dataset.loader import EpisodeContext
from ...dataset.preroll import signal_start
from ...dataset.scan import scan_episode
from ..base import HardCritic, ramp
from ..registry import register
from ._util import longest_run


@register
class DuplicationCritic(HardCritic):
    id = "duplication"
    description = (
        "Technical stalls: near-duplicate consecutive camera frames WHILE THE ROBOT MOVES (a static scene legitimately "
        "re-encodes to identical frames, a moving arm never does), the longest span where every camera was frozen at "
        "once, and frozen action / state rows in the parquet (identical consecutive command vectors). A moderate "
        "camera duplicate baseline is a rig property (USB bandwidth); long runs and frozen commands are episode faults."
    )
    default_params = {
        "near_dup_eps": 0.5,  # mean |gray diff| on 8x thumbnails below this = repeated frame
        "motion_eps_mps": 0.01,  # robot speed (m/s, or normalized units/s) above which the scene must change
        "video_dup_good": 0.35,  # dup rate while moving
        "video_dup_bad": 0.70,
        "video_run_good_s": 1.0,  # longest frozen camera run while moving (s); a camera that doesn't see the arm can be static
        "video_run_bad_s": 3.0,
        "all_cams_run_good_s": 0.5,  # longest span where ALL cameras were frozen at once
        "all_cams_run_bad_s": 2.0,
        "action_dup_good": 0.02,  # fraction of frames whose command vector is identical to the previous one
        "action_dup_bad": 0.20,
        "action_run_good_s": 0.5,
        "action_run_bad_s": 3.0,
        "state_dup_good": 0.02,
        "state_dup_bad": 0.30,
        "cameras": None,  # subset of cameras; None = all
        # frozen-run scoring only on cameras that MUST change when the arm moves (wrist/hand cameras);
        # a static body camera legitimately repeats frames while the arm is out of its view.
        # None = auto (wrist cameras, else all).
        "run_cameras": None,
    }
    relative_flags = {
        "action_dup_rate": ("LAGGY_OUTLIER", +1),
        "video_dup_rate_max": ("CAMSTALL_OUTLIER", +1),
    }

    def _moving_mask(self, ep: EpisodeContext, rf, st: int = 0) -> np.ndarray | None:
        """True where any active arm's follower state moves faster than motion_eps (per frame),
        from frame ``st`` on."""
        eps = float(self.p("motion_eps_mps")) / ep.fps
        speeds = []
        for p in rf.active_pairs or rf.pairs:
            if p.kind == "hand" or not ep.has(p.state):
                continue
            s = ep.array(p.state)[st:]
            pos = s[:, :3] if p.kind == "cartesian" else s / np.maximum(np.ptp(s, axis=0), 1e-9)
            speeds.append(np.linalg.norm(np.diff(pos, axis=0), axis=1))
        if not speeds:
            return None
        v = np.max(np.stack(speeds), axis=0)
        # smooth a little so brief zero-velocity turning points don't break runs
        k = max(1, int(ep.fps // 10))
        v = np.convolve(np.pad(v, (k // 2, k - 1 - k // 2), mode="edge"), np.ones(k) / k, mode="valid")
        return np.concatenate([[False], v > eps])

    def evaluate(self, ep: EpisodeContext):
        dt = 1.0 / ep.fps
        m: dict = {}
        flags: list[str] = []
        ev: list[str] = []
        parts: list[float] = []

        rf = ep.cache.get("features") or detect_features(ep.ds, self.spec, ep)
        ep.cache["features"] = rf
        st = signal_start(ep, self.spec, rf)  # the pre-roll is neither a stall nor a frozen command
        moving = self._moving_mask(ep, rf, st)

        cams = self.p("cameras") or ep.cameras
        run_cams = self.p("run_cameras") or rf.wrist_cameras or cams
        # the wrist camera of an arm that is not doing the task looks at a still scene: its repeated
        # frames are a fact of the rig, not a stall. Measured, never decisive.
        active_arms = [a.lower() for a in self.spec.robot.active_arms]
        idle_cams = {c for c in cams if active_arms and _arm_of(c) and _arm_of(c) not in active_arms}
        if cams:
            scan = scan_episode(ep, cams, near_dup_eps=float(self.p("near_dup_eps")))
            rates, run_max = [], 0
            masks = []
            for c in cams:
                sc = scan.get(c)
                if not sc or sc["frames"] == 0:
                    continue
                if c in idle_cams:
                    m[f"video_dup_rate.{c}"] = sc["near_dup_rate"]
                    continue
                mask = np.asarray(sc.get("dup_mask", []), dtype=bool)[st:]
                n = min(len(mask), len(moving)) if moving is not None else len(mask)
                gated = mask[:n] & moving[:n] if moving is not None else mask[:n]
                denom = int(moving[:n].sum()) if moving is not None else n
                rate = float(gated.sum() / denom) if denom > 0 else 0.0
                run = longest_run(gated)
                rates.append(rate)
                if c in run_cams:
                    run_max = max(run_max, run)
                masks.append(mask[:n])
                m[f"video_dup_rate.{c}"] = sc["near_dup_rate"]  # raw, rig statistic
                m[f"video_dup_rate_moving.{c}"] = rate
                m[f"video_dup_run_moving.{c}"] = run
            if rates:
                m["video_dup_rate_max"] = max(rates)
                m["video_dup_run_max_s"] = run_max * dt
                parts.append(ramp(max(rates), self.p("video_dup_good"), self.p("video_dup_bad")))
                parts.append(ramp(run_max * dt, self.p("video_run_good_s"), self.p("video_run_bad_s")))
                if max(rates) > float(self.p("video_dup_bad")) or run_max * dt > float(
                    self.p("video_run_bad_s")
                ):
                    flags.append("CAMSTALL")
                    ev.append(
                        f"camera frames repeated while the robot moved: max rate {max(rates):.2f}, longest freeze {run_max * dt:.2f}s"
                    )
            if len(masks) > 1:
                n = min(len(x) for x in masks)
                all_dup = np.logical_and.reduce([x[:n] for x in masks])
                run_all = longest_run(all_dup)
                m["all_cams_dup_run_s"] = run_all * dt
                parts.append(ramp(run_all * dt, self.p("all_cams_run_good_s"), self.p("all_cams_run_bad_s")))
                if run_all * dt > float(self.p("all_cams_run_bad_s")):
                    flags.append("CAMSTALL")
                    ev.append(f"all cameras frozen simultaneously for {run_all * dt:.2f}s")
        act_keys = sorted({p.action for p in rf.pairs}) or [
            k for k in ep.ds.numeric_keys if k.startswith("action")
        ]
        st_keys = sorted({p.state for p in rf.pairs}) or [
            k for k in ep.ds.numeric_keys if k.startswith("observation.state")
        ]
        if act_keys:
            A = np.concatenate([ep.array(k)[st:] for k in act_keys if ep.has(k)], axis=1)
            same = (np.diff(A, axis=0) == 0).all(axis=1)
            rate, run = float(same.mean()), longest_run(same)
            m["action_dup_rate"] = rate
            m["action_dup_run_s"] = run * dt
            parts.append(ramp(rate, self.p("action_dup_good"), self.p("action_dup_bad")))
            parts.append(ramp(run * dt, self.p("action_run_good_s"), self.p("action_run_bad_s")))
            if rate > float(self.p("action_dup_bad")) or run * dt > float(self.p("action_run_bad_s")):
                flags.append("LAGGY")
                ev.append(f"command vector frozen in {rate * 100:.1f}% of frames, longest {run * dt:.2f}s")
        if st_keys:
            S = np.concatenate([ep.array(k)[st:] for k in st_keys if ep.has(k)], axis=1)
            same = (np.diff(S, axis=0) == 0).all(axis=1)
            m["state_dup_rate"] = float(same.mean())
            m["state_dup_run_s"] = longest_run(same) * dt
            parts.append(ramp(float(same.mean()), self.p("state_dup_good"), self.p("state_dup_bad")))
            if float(same.mean()) > float(self.p("state_dup_bad")):
                flags.append("STATE_FROZEN")
        if not parts:
            return self.result(None, m, error="nothing to check")
        # worst aspect dominates; the mean only softens single mild issues
        score = 0.7 * min(parts) + 0.3 * float(np.mean(parts))
        return self.result(score, m, flags, ev)
