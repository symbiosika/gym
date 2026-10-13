"""Training-statistics hygiene: things that do not break an episode when you watch it, but
break the *normalisation* and the *action space* of every policy trained on the dataset.

* all-zero dropout frames (a cartesian pose of exactly (0, 0, 0)): one such frame in one
  episode drags the dataset's min/max range to 0 -> the z resolution of every action target
  shrinks by a factor of 5 (a long-horizon cup->tray dataset, episodes 3 and 7, frame 0). A leading span of
  zero commands long enough to be the start-up delay of the controller or policy (the
  pre-roll, ``robot.preroll_min_s``) is not a dropout: it is reported as ``preroll_s`` and
  left out of the count, the range and the score;
* action dimensions that never change (constant dims carry no information);
* arms that should idle but drift (their noise becomes a prediction target);
* "actions" that are byte-for-byte copies of the state (no lead over the robot).

Per episode the critic scores the dropout frames and the idle-arm drift. The dataset-level
summary (``summarize``) compares ``meta/stats.json`` min/max with the true range of the data
without the dropout rows and reports the inflation factor per dimension.
"""

from __future__ import annotations

import json

import numpy as np

from ...dataset.features import detect_features
from ...dataset.loader import EpisodeContext
from ...dataset.preroll import signal_start
from ..base import CriticResult, HardCritic, ramp
from ..registry import register


def _zero_rows(arr: np.ndarray, cartesian: bool) -> np.ndarray:
    """Rows that are exactly zero (xyz for cartesian features, the whole vector otherwise)."""
    x = arr[:, :3] if cartesian else arr
    zero = np.abs(x).sum(1) == 0
    if not cartesian:
        # a joint/hand vector that is legitimately all zero (fully open hand) is not a dropout:
        # require that neighbours are non-zero
        if zero.all() or zero.sum() > 0.2 * len(zero):
            return np.zeros(len(zero), dtype=bool)
    return zero


@register
class NormalizationCritic(HardCritic):
    id = "normalization"
    description = (
        "Training-statistics hygiene. Per episode: all-zero dropout frames in pose/joint features (they drag the "
        "dataset min/max normalisation range to 0), the start-up delay before the first real command (the "
        "pre-roll, reported and not counted), constant action dimensions, drift of arms that should idle "
        "(robot.active_arms), and action features that are mere copies of the state. Dataset level: inflation of "
        "the meta/stats.json min/max range caused by those dropout frames, dimension by dimension."
    )
    default_params = {
        "zero_frame_penalty": 0.5,  # score after the first all-zero frame (flag ZERO_FRAMES)
        "idle_path_good_m_per_min": 0.3,  # an idle arm that drifts less than this per minute is fine
        "idle_path_bad_m_per_min": 1.5,
        "idle_flag_m_per_min": 0.5,  # IDLE_ARM_DRIFT above this
        "copy_tolerance": 0.01,  # max |a - s| / range below this = action is a copy of the state
        "dead_eps": 1e-6,
        "inflation_flag": 1.5,  # dataset-level STATS_RANGE_INFLATED when any dim's range is inflated by more
        "stats_file": "meta/stats.json",
    }

    def evaluate(self, ep: EpisodeContext):
        rf = ep.cache.get("features") or detect_features(ep.ds, self.spec, ep)
        ep.cache["features"] = rf
        m: dict = {}
        flags: list[str] = []
        ev: list[str] = []
        total_zero = 0
        st = signal_start(ep, self.spec, rf)
        if st:
            m["preroll_frames"] = st
            m["preroll_s"] = st / ep.fps
            ev.append(f"the command starts {st / ep.fps:.1f}s into the episode (pre-roll, not counted)")
        keys = [k for k in ep.ds.numeric_keys if k.startswith(("action", "observation.state")) and ep.has(k)]
        kinds = {p.action: p.kind for p in rf.pairs}
        kinds.update({p.state: p.kind for p in rf.pairs})
        for k in keys:
            arr = ep.array(k)
            if arr.ndim != 2 or arr.shape[1] == 0:
                continue
            cart = kinds.get(k) == "cartesian" or (kinds.get(k) is None and arr.shape[1] in (3, 6, 7, 9))
            z = _zero_rows(arr, cart)
            z[:st] = False  # the pre-roll is a delay, not dropouts
            if z.any() and not z.all():
                n = int(z.sum())
                total_zero += n
                m[f"zero_frames.{k}"] = n
                m[f"zero_frame_index.{k}"] = [int(i) for i in np.where(z)[0][:8]]
                ev.append(f"{k}: {n} all-zero frame(s) at {[int(i) for i in np.where(z)[0][:5]]}")
            ok = ~z
            ok[:st] = False
            if ok.any():
                m[f"_range.{k}"] = [arr[ok].min(0).tolist(), arr[ok].max(0).tolist()]
            if k.startswith("action"):
                rng = np.ptp(arr[ok], axis=0) if ok.any() else np.zeros(arr.shape[1])
                dead = [i for i in range(arr.shape[1]) if rng[i] < float(self.p("dead_eps"))]
                if dead:
                    names = ep.names(k)
                    m[f"dead_dims.{k}"] = [names[i] if i < len(names) else str(i) for i in dead]
        m["zero_frames"] = total_zero
        m["_episode"] = ep.index
        if total_zero:
            flags.append("ZERO_FRAMES")

        # idle arms: the other hand's motion leaks into the action space
        idle_rate = 0.0
        dur_min = max(ep.duration_s / 60.0, 1e-6)
        for p in rf.pairs:
            if p.active or not ep.has(p.state):
                continue
            s = ep.array(p.state)
            if p.kind == "cartesian":
                ok = np.abs(s[:, :3]).sum(1) > 0
                pos = s[ok, :3]
                path = float(np.linalg.norm(np.diff(pos, axis=0), axis=1).sum()) if len(pos) > 1 else 0.0
                m[f"idle_arm_path_m.{p.state}"] = path
                idle_rate = max(idle_rate, path / dur_min)
            elif p.kind == "hand":
                m[f"idle_hand_range.{p.state}"] = float(np.ptp(s, axis=0).max()) if len(s) else 0.0
        has_idle = any(not p.active for p in rf.pairs)
        if has_idle:
            m["idle_arm_path_m_per_min"] = idle_rate
            if idle_rate > float(self.p("idle_flag_m_per_min")):
                flags.append("IDLE_ARM_DRIFT")
                ev.append(
                    f"an arm that should idle travelled {idle_rate:.2f} m/min - its motion becomes noise in the action space"
                )

        # action == state copies
        for p in rf.pairs:
            if not (ep.has(p.action) and ep.has(p.state)) or p.action == p.state:
                continue
            a, s = ep.array(p.action)[st:], ep.array(p.state)[st:]
            if a.shape != s.shape:
                continue
            rng = float(np.ptp(np.concatenate([a, s]), axis=0).max())
            if rng <= 0:
                continue
            copy = bool(np.abs(a - s).max() / rng < float(self.p("copy_tolerance")))
            m[f"action_equals_state.{p.action}"] = copy
            # a binary gripper command legitimately equals its state; only arm features are flagged
            if copy and p.active and p.kind != "hand":
                flags.append("ACTION_IS_STATE")
                ev.append(f"{p.action} never differs from {p.state}: the action is a readback, not a command")

        score = 1.0
        if total_zero:
            score = min(score, float(self.p("zero_frame_penalty")))
        if has_idle:
            score = min(
                score,
                ramp(
                    idle_rate,
                    float(self.p("idle_path_good_m_per_min")),
                    float(self.p("idle_path_bad_m_per_min")),
                ),
            )
        return self.result(score, m, sorted(set(flags)), ev)

    # ------------------------------------------------------------- dataset level
    def summarize(self, results: list[CriticResult]) -> dict | None:
        out: dict = {}
        zero_eps: list = []
        prerolls: dict[int, float] = {}
        true_min: dict[str, np.ndarray] = {}
        true_max: dict[str, np.ndarray] = {}
        dead: dict[str, set] = {}
        copies: dict[str, int] = {}
        zero_feats: set[str] = set()
        for r in results:
            if r.metrics.get("zero_frames"):
                zero_eps.append(r.metrics.get("_episode"))
            if r.metrics.get("preroll_s") and r.metrics.get("_episode") is not None:
                prerolls[int(r.metrics["_episode"])] = float(r.metrics["preroll_s"])
            for k, v in r.metrics.items():
                if k.startswith("zero_frames.") and v:
                    zero_feats.add(k[len("zero_frames.") :])
                if k.startswith("_range.") and isinstance(v, list) and len(v) == 2:
                    feat = k[len("_range.") :]
                    lo, hi = np.asarray(v[0], float), np.asarray(v[1], float)
                    true_min[feat] = np.minimum(true_min[feat], lo) if feat in true_min else lo
                    true_max[feat] = np.maximum(true_max[feat], hi) if feat in true_max else hi
                elif k.startswith("dead_dims."):
                    dead.setdefault(k[len("dead_dims.") :], set()).update(v or [])
                elif k.startswith("action_equals_state.") and v:
                    copies[k[len("action_equals_state.") :]] = (
                        copies.get(k[len("action_equals_state.") :], 0) + 1
                    )
        flags: dict[str, str] = {}
        out["episodes_with_zero_frames"] = [e for e in zero_eps if e is not None]
        # rollouts are never trained on: the training-statistics findings below say nothing
        # about them, only the start-up delay does
        training = not self.spec.is_evaluation
        if prerolls:
            # the start-up delay of the session: how long the recorder ran before the first command
            vals = np.array(list(prerolls.values()))
            out["episodes_with_preroll"] = sorted(prerolls)
            out["preroll_s_median"] = float(np.median(vals))
            out["preroll_s_max"] = float(vals.max())
            out["preroll_note"] = (
                f"{len(prerolls)} of {len(results)} episode(s) start with a span of zero commands while the "
                f"state is valid (median {np.median(vals):.1f}s, max {vals.max():.1f}s): the delay before the "
                "controller or policy took over. The signal critics measured from its end. For training, trim "
                "it: it is dead time in the demonstration and its zero rows corrupt min/max statistics."
            )
        # dead dims: only those constant in EVERY episode that reported the feature
        n_eps = len(results)
        dead_all = {}
        for feat, dims in dead.items():
            cnt = {
                d: sum(1 for r in results if d in (r.metrics.get(f"dead_dims.{feat}") or [])) for d in dims
            }
            const = sorted(d for d, c in cnt.items() if c == n_eps)
            if const:
                dead_all[feat] = const
        if dead_all:
            out["dead_action_dims"] = dead_all
        if copies:
            out["action_equals_state_episodes"] = copies
        # min/max inflation vs stats.json
        ds = getattr(self, "ds", None)
        stats = None
        if ds is not None:
            p = ds.root / str(self.p("stats_file"))
            if p.is_file():
                try:
                    stats = json.loads(p.read_text())
                except Exception:  # noqa: BLE001
                    stats = None
        out["stats_file_found"] = stats is not None
        if stats is not None and training:
            inflated: dict[str, dict] = {}
            worst = 1.0
            for feat, lo in true_min.items():
                st = stats.get(feat)
                if not isinstance(st, dict) or "min" not in st or "max" not in st:
                    continue
                smin = np.asarray(st["min"], float).ravel()
                smax = np.asarray(st["max"], float).ravel()
                hi = true_max[feat]
                if smin.shape != lo.shape:
                    continue
                true_rng = np.maximum(hi - lo, 1e-9)
                stat_rng = smax - smin
                factor = stat_rng / true_rng
                bad = np.where(factor > float(self.p("inflation_flag")))[0]
                if len(bad):
                    inflated[feat] = {
                        "has_zero_frames": feat in zero_feats,
                        "dims": [int(i) for i in bad],
                        "factor": [round(float(factor[i]), 2) for i in bad],
                        "stats_min": [round(float(smin[i]), 4) for i in bad],
                        "true_min": [round(float(lo[i]), 4) for i in bad],
                        "stats_max": [round(float(smax[i]), 4) for i in bad],
                        "true_max": [round(float(hi[i]), 4) for i in bad],
                    }
                    worst = max(worst, float(factor.max()))
            out["range_inflation_max"] = worst
            out["range_note"] = (
                f"true ranges computed over the {len(results)} evaluated episode(s) without all-zero rows; "
                "features without zero frames can show a factor > 1 simply because stats.json covers more episodes"
            )
            out["zero_frame_features"] = sorted(zero_feats)
            if inflated:
                out["range_inflated_features"] = inflated
                culprits = {f: v for f, v in inflated.items() if v["has_zero_frames"]} or inflated
                feats = ", ".join(
                    f"{f} dims {v['dims']} x{max(v['factor']):.1f}" for f, v in culprits.items()
                )
                flags["STATS_RANGE_INFLATED"] = (
                    f"meta/stats.json min/max is wider than the real data by more than {self.p('inflation_flag')}x on: "
                    f"{feats}. With min_max normalisation the policy trains at a fraction of the action resolution. "
                    "Remove the all-zero frames and recompute stats.json (or switch those features to q99/mean_std)."
                )
        if zero_eps and training:
            flags["ZERO_FRAMES"] = (
                f"{len(zero_eps)} episode(s) contain all-zero dropout frames ({sorted(e for e in zero_eps if e is not None)}). "
                "Drop or repair those frames before computing normalisation statistics."
            )
        if dead_all and training:
            flags["DEAD_ACTION_DIMS"] = (
                "action dimensions constant across the whole run: "
                + "; ".join(f"{f}: {d}" for f, d in dead_all.items())
                + ". They carry no information - exclude them from the action space or leave them out of the loss."
            )
        if copies and training:
            flags["ACTION_IS_STATE"] = (
                "action features that are copies of the state in some episodes: "
                + ", ".join(f"{f} ({n} ep)" for f, n in copies.items())
            )
        out["flags"] = flags
        return out
