"""Recording-session profile: the handful of physical numbers that describe *how* a dataset
was recorded, aggregated over the run and judged against the critics' own thresholds.

The per-episode verdicts say which episodes to drop. They do not say what is wrong with the
*session*: how much the robot lags the operator's command, whether the input device shakes,
whether the hand comes to rest before it closes, whether the object ever moved between
episodes, whether a dropout frame corrupted the normalisation statistics. Those are the
questions a team asks before the next recording day, and they are answered here as a list of
**indicators**, each with a median, a spread, a per-episode series, a status (good / warn /
bad / info) derived from the thresholds the spec configured for the critic that produced it,
and plain-English "what it means" / "what to do" text.

The profile is computed once per run (``DatasetReport.session_profile``) and rendered by
``report.md``, ``report_ai.md``, the visual HTML report and the web UI. ``build_session_profile``
also works on reports written before the field existed.
"""

from __future__ import annotations

from collections import Counter
from typing import TYPE_CHECKING, Any

import numpy as np

from .metrics_doc import describe_metric

if TYPE_CHECKING:  # pragma: no cover
    from .runner import DatasetReport

Status = str  # "good" | "warn" | "bad" | "info"

GROUPS: list[tuple[str, str, str]] = [
    (
        "teleop",
        "Teleoperation: command vs. robot",
        "How faithfully and how quickly the robot reproduced the operator's command, and how clean the "
        "command itself was. This is what the policy will imitate.",
    ),
    (
        "grasp",
        "Grasp behaviour",
        "How the operator grasped: how many attempts per episode, how long the closing took, whether the "
        "hand had stopped before it closed.",
    ),
    (
        "diversity",
        "Variation across the session",
        "What the demonstrations cover. A policy only learns to correct towards an object it has seen in "
        "different places.",
    ),
    (
        "hygiene",
        "Data hygiene for training",
        "Artifacts that do not spoil a single episode but spoil the training set: dropout frames in the "
        "normalisation statistics, idle arms that move, frozen streams, stalled cameras.",
    ),
]


# ------------------------------------------------------------------ helpers
def _critic_params(report: DatasetReport, cid: str) -> dict[str, Any]:
    """Effective parameters of a critic in this run: its defaults overlaid with the spec's params."""
    params: dict[str, Any] = {}
    try:
        from .critics.registry import get_hard_critic

        params.update(get_hard_critic(cid).default_params)
    except Exception:  # noqa: BLE001 - unknown critic: no defaults
        pass
    spec = report.spec if isinstance(report.spec, dict) else {}
    for cfg in spec.get("hard_critics") or []:
        if cfg.get("id") == cid:
            params.update(cfg.get("params") or {})
    return params


def _series(report: DatasetReport, cid: str, key: str) -> dict[int, float]:
    out: dict[int, float] = {}
    for r in report.episodes:
        for h in r.hard:
            if h.id == cid:
                v = h.metrics.get(key)
                if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v:
                    out[r.episode] = float(v)
    return out


def _str_series(report: DatasetReport, cid: str, key: str) -> list[str]:
    return [
        str(h.metrics[key])
        for r in report.episodes
        for h in r.hard
        if h.id == cid and isinstance(h.metrics.get(key), str)
    ]


def _status(value: float | None, good: float | None, bad: float | None, better: str) -> Status:
    if value is None or good is None or bad is None or better not in ("lower", "higher"):
        return "info"
    if better == "lower":
        return "good" if value <= good else "bad" if value >= bad else "warn"
    return "good" if value >= good else "bad" if value <= bad else "warn"


def _fmt(v: float | None, digits: int = 1) -> str:
    if v is None:
        return "–"
    if abs(v) >= 100:
        return f"{v:.0f}"
    if abs(v) >= 10:
        return f"{v:.1f}"
    return f"{v:.{max(digits, 2)}f}".rstrip("0").rstrip(".") if abs(v) < 1 else f"{v:.{digits}f}"


class _Builder:
    def __init__(self, report: DatasetReport):
        self.report = report
        self.indicators: list[dict[str, Any]] = []

    def add(
        self,
        id: str,
        group: str,
        label: str,
        unit: str,
        *,
        critic: str | None = None,
        key: str | None = None,
        value: float | None = None,
        series: dict[int, float] | None = None,
        better: str = "info",
        good: float | None = None,
        bad: float | None = None,
        what: str = "",
        so_what: str = "",
        action: str = "",
        text_value: str | None = None,
        digits: int = 1,
        aggregate: str = "median",
    ) -> dict[str, Any] | None:
        if series is None and critic and key:
            series = _series(self.report, critic, key)
        series = series or {}
        if value is None and series:
            vals = np.array(list(series.values()), float)
            value = float(np.median(vals) if aggregate == "median" else vals.sum())
        if value is None and text_value is None:
            return None
        if not what and critic and key:
            d = describe_metric(critic, key)
            what = d.what if d else ""
        vals = np.array(list(series.values()), float) if series else np.array([], float)
        ind = {
            "id": id,
            "group": group,
            "label": label,
            "unit": unit,
            "value": value,
            "text_value": text_value,
            "display": text_value if text_value is not None else _fmt(value, digits),
            "aggregate": aggregate,
            "low": float(vals.min()) if len(vals) else None,
            "high": float(vals.max()) if len(vals) else None,
            "n": int(len(vals)),
            "status": _status(value, good, bad, better),
            "better": better,
            "good": good,
            "bad": bad,
            "series": {str(k): round(v, 4) for k, v in sorted(series.items())},
            "what": what,
            "so_what": so_what,
            "action": action,
            "source": f"{critic}.{key}" if critic and key else "",
        }
        self.indicators.append(ind)
        return ind


# ------------------------------------------------------------------ main entry
def build_session_profile(report: DatasetReport) -> dict[str, Any]:
    """Aggregate the run's per-episode metrics into the session indicators (see module doc).

    Rollouts of a policy (spec purpose ``evaluation``) have no recording session: nothing here
    says what to change at the rig or the teleop, so the profile is empty.
    """
    if str((report.spec or {}).get("purpose") or "recording") == "evaluation":
        return {}
    b = _Builder(report)
    fps = float(report.fps or 30.0)
    te = _critic_params(report, "tracking_error")
    tr = _critic_params(report, "tremor")
    sm = _critic_params(report, "smoothness")
    nz = _critic_params(report, "normalization")
    dv = _critic_params(report, "diversity")
    du = _critic_params(report, "duplication")
    summ = report.dataset_summaries or {}

    # ---------------- teleop
    lag = b.add(
        "latency_ms",
        "teleop",
        "Teleop latency: command → robot",
        "ms",
        critic="tracking_error",
        key="lag_ms",
        better="lower",
        good=float(te.get("latency_good_ms", 100.0)),
        bad=float(te.get("latency_bad_ms", 300.0)),
        digits=0,
        what=(
            "Delay between the recorded command (action) and the recorded robot state (observation), "
            "from the cross-correlation of their velocities. Measures IK, controller and transport between the two "
            "topics; VR tracking and network before the command topic are not included. Thresholds: a tight "
            "position controller stays under 100 ms; above 300 ms the operator visibly fights the delay "
            "(tracking_error params latency_good_ms / latency_bad_ms)."
        ),
        so_what=(
            "The operator only sees the robot's reaction this much later and compensates visually: overshoot and "
            "re-corrections near the object end up in the demonstrations. A policy trained on the raw command must "
            "reproduce that lead over the robot; anything that changes the controller latency at inference time "
            "changes the policy's behaviour."
        ),
        action="hand the number to the teleop / controller team; re-measure after every change to the control chain",
    )
    if lag is not None:
        lag["display_extra"] = (
            f"{lag['low']:.0f}–{lag['high']:.0f} ms across episodes · {lag['value'] / 1000 * fps:.1f} frames at {fps:g} fps"
        )
    b.add(
        "latency_share",
        "teleop",
        "Share of the tracking gap that is pure delay",
        "%",
        series={k: v * 100 for k, v in _series(report, "tracking_error", "lag_err_share").items()},
        better="info",
        digits=0,
        what=(
            "How much of the visible distance between commanded and measured position disappears once the state is "
            "shifted by the latency. The rest is controller damping or real tracking error."
        ),
        so_what="Near 100 % means the robot follows precisely, just late; a low share means it also does not reach the commanded pose.",
    )
    b.add(
        "tracking_error_mm",
        "teleop",
        "Tracking error after latency compensation",
        "mm",
        critic="tracking_error",
        key="pos_err_mean_mm",
        better="lower",
        good=float(te.get("pos_good_mm", 8.0)),
        bad=float(te.get("pos_bad_mm", 40.0)),
        so_what="Residual gap between where the operator pointed and where the robot went, delay removed: damping, gains, payload.",
        action="check controller gains and payload if this is high",
    )
    trem = b.add(
        "tremor_cmd",
        "teleop",
        "Tremor in the command (velocity power > 5 Hz)",
        "%",
        series={k: v * 100 for k, v in _series(report, "tremor", "hf5_share_cmd").items()},
        better="lower",
        good=float(tr.get("hf_good", 0.05)) * 100,
        bad=float(tr.get("hf_bad", 0.35)) * 100,
        digits=0,
        what=(
            "Share of the commanded wrist velocity power above 5 Hz. Human hand tremor sits at 8–12 Hz; a hand-held "
            "or hand-tracked input device passes it straight into the command."
        ),
        so_what="The policy learns the shaking as its target. The robot state shows how much the controller filters away.",
        action="support the operator's arm, lower the input sensitivity, add a filter on the teleop side, or low-pass the actions before training",
    )
    st_share = _series(report, "tremor", "hf5_share_state")
    if trem is not None and st_share:
        trem["state_series"] = {str(k): round(v * 100, 2) for k, v in sorted(st_share.items())}
        trem["state_value"] = float(np.median(list(st_share.values())) * 100)
        peak = _series(report, "tremor", "tremor_peak_hz_cmd")
        src = Counter(_str_series(report, "tremor", "tremor_source")).most_common(1)
        peak_med = float(np.median(list(peak.values()))) if peak else None
        trem["peak_hz"] = peak_med
        trem["source"] = src[0][0] if src else None
        trem["display_extra"] = (
            f"robot state {trem['state_value']:.0f} % · peak {peak_med:.1f} Hz · source: {trem['source']}"
            if peak_med is not None
            else f"robot state {trem['state_value']:.0f} %"
        )
    b.add(
        "hold_rms_cmd",
        "teleop",
        "Command motion while the hand should be still",
        "mm/s",
        critic="tremor",
        key="hold_rms_speed_cmd_mms",
        better="lower",
        good=float(tr.get("hold_rms_good_mms", 5.0)),
        bad=float(tr.get("hold_rms_bad_mms", 40.0)),
        so_what="A truly resting hand gives a few mm/s. Higher values mean the command never rests before or during the grasp and the policy learns to fidget at the object.",
        action="give the operator a clutch / hold, or pause deliberately before closing",
    )
    b.add(
        "spikes_per_min",
        "teleop",
        "Implausible command jumps",
        "/min",
        critic="smoothness",
        key="spike_rate_per_min",
        better="lower",
        good=float(sm.get("spike_rate_good", 0.0)),
        bad=float(sm.get("spike_rate_bad", 3.0)),
        so_what="Single-frame jumps the robot cannot execute; a training target no policy should learn.",
        action="check the input device and transport for dropouts",
    )

    # ---------------- grasp
    cyc = b.add(
        "cycles",
        "grasp",
        "Grasp cycles per episode",
        "",
        critic="grasp_cycles",
        key="n_cycles",
        better="info",
        so_what="One cycle = one pick-and-place attempt that carried the object.",
    )
    expected = (
        (report.spec.get("task") or {}).get("expected_cycles") if isinstance(report.spec, dict) else None
    )
    if cyc is not None and expected:
        cyc["display_extra"] = f"expected {expected}"
    b.add(
        "close_dur_s",
        "grasp",
        "Closing duration",
        "s",
        critic="grasp_cycles",
        key="close_dur_median_s",
        better="info",
        so_what="Time from open to closed hand around each grasp. Long closings mean hesitant or careful grasping.",
    )
    b.add(
        "wrist_move_close_mm",
        "grasp",
        "Wrist motion while closing",
        "mm",
        critic="grasp_cycles",
        key="wrist_move_during_close_median_mm",
        better="lower",
        good=5.0,
        bad=30.0,
        so_what="A clean grasp stops, then closes (a few mm). Larger values mean grasping on the move or correcting during the close - exactly the phase where the policy fails first.",
        action="train operators to stop, close, pause, lift",
    )
    b.add(
        "settle_s",
        "grasp",
        "Settle time before closing",
        "s",
        critic="grasp_cycles",
        key="settle_before_close_median_s",
        better="higher",
        good=0.5,
        bad=0.1,
        so_what="How long the wrist had already been slow before the hand started closing. 0 means the operator closed while still approaching.",
        action="pause about half a second before closing; it also makes later annotation trivial",
    )
    b.add(
        "active_frac",
        "grasp",
        "Share of the episode with the arm moving",
        "%",
        series={k: v * 100 for k, v in _series(report, "grasp_cycles", "active_frac").items()},
        better="info",
        digits=0,
        so_what="The rest is waiting: resets, a person in the workspace, idle time. With one task string the policy learns 'do nothing' from those frames.",
        action="cut episodes at the reset phases or record one attempt per episode",
    )

    # ---------------- diversity
    div = summ.get("diversity") or {}
    gp = div.get("grasp_positions") or {}
    spread = div.get("grasp_horizontal_spread_cm")
    if spread is not None:
        ind = b.add(
            "grasp_spread_cm",
            "diversity",
            "Spread of the grasp positions",
            "cm",
            value=float(spread),
            better="higher",
            good=max(5.0, float(dv.get("low_std_cm", 3.0)) + 2.0),
            bad=float(dv.get("low_std_cm", 3.0)),
            what=(
                "Robust standard deviation (1.4826 × MAD) of the wrist position at the grasp keyframes over the whole "
                "run, horizontal axes, in cm. It is the spread of the object positions the policy has seen."
            ),
            so_what="Below a few cm the approach can be replayed from memory and no visual correction is ever demonstrated. Since the object was always in the same place, a small offset at inference has no counterpart in the data.",
            action="randomise the object position over the workspace between episodes",
        )
        if ind is not None and gp:
            ind["display_extra"] = (
                f"robust std x/y/z {'/'.join(f'{v:g}' for v in gp.get('robust_std_cm', []))} cm · "
                f"range {'/'.join(f'{v:g}' for v in gp.get('range_cm', []))} cm · {gp.get('n', 0)} grasps"
            )
    starts = div.get("start_pose_std_cm")
    if starts:
        b.add(
            "start_spread_cm",
            "diversity",
            "Spread of the start pose",
            "cm",
            value=float(max(starts)),
            better="info",
            what="Standard deviation of the wrist position in the first frame across episodes (largest axis).",
            so_what="Varied start poses are good: the policy must not depend on one initial configuration.",
        )
    b.add(
        "duration_s",
        "diversity",
        "Episode duration",
        "s",
        critic="duration",
        key="duration_s",
        better="info",
        digits=0,
        so_what="Long episodes usually pack several attempts and waiting phases; one attempt per episode is easier to train and to filter.",
    )

    # ---------------- hygiene
    zero = _series(report, "normalization", "zero_frames")
    if zero:
        ind = b.add(
            "zero_frames",
            "hygiene",
            "All-zero dropout rows",
            "rows",
            series=zero,
            better="lower",
            good=0.0,
            bad=1.0,
            aggregate="sum",
            digits=0,
            what="Rows where a pose or joint vector is exactly zero (counted per feature): a transport dropout, not a real pose.",
            so_what="One such frame drags the dataset's min/max normalisation range to 0. The policy then trains at a fraction of its action resolution on the affected axes.",
            action="remove or repair those frames, then recompute meta/stats.json",
        )
        eps = [int(k) for k, v in zero.items() if v]
        if ind is not None and eps:
            ind["display_extra"] = f"in episode(s) {eps}"
    norm = summ.get("normalization") or {}
    infl = norm.get("range_inflation_max")
    if infl is not None and norm.get("stats_file_found"):
        ind = b.add(
            "range_inflation",
            "hygiene",
            "Inflation of the min/max normalisation range",
            "×",
            value=float(infl),
            better="lower",
            good=1.05,
            bad=float(nz.get("inflation_flag", 1.5)),
            what="meta/stats.json range divided by the real range of the data without dropout rows, worst dimension.",
            so_what="With min_max normalisation an inflation of 5× means the policy's targets on that axis use a fifth of the available resolution.",
            action="recompute stats.json without the dropout frames or switch the feature to q99 / mean-std normalisation",
        )
        feats = norm.get("range_inflated_features") or {}
        if ind is not None and feats:
            ind["display_extra"] = "; ".join(
                f"{f.split('.')[-1]} dims {v.get('dims')} ×{max(v.get('factor') or [1]):.1f}"
                for f, v in feats.items()
            )
    b.add(
        "idle_arm_drift",
        "hygiene",
        "Drift of the idle arm",
        "m/min",
        critic="normalization",
        key="idle_arm_path_m_per_min",
        better="lower",
        good=float(nz.get("idle_path_good_m_per_min", 0.3)),
        bad=float(nz.get("idle_path_bad_m_per_min", 1.5)),
        digits=2,
        so_what="An arm that is not doing the task but moves adds noise dimensions the policy has to predict.",
        action="park the idle arm in a fixed pose or take it out of the action space",
    )
    b.add(
        "action_frozen",
        "hygiene",
        "Frozen command stream",
        "%",
        series={k: v * 100 for k, v in _series(report, "duplication", "action_dup_rate").items()},
        better="lower",
        good=float(du.get("action_dup_good", 0.02)) * 100,
        bad=float(du.get("action_dup_bad", 0.20)) * 100,
        digits=1,
        so_what="Frames whose whole command vector repeats the previous one: the teleop link stalled.",
        action="check the teleop link and recorder loop rate",
    )
    b.add(
        "camera_stall",
        "hygiene",
        "Repeated camera frames while moving",
        "%",
        series={k: v * 100 for k, v in _series(report, "duplication", "video_dup_rate_max").items()},
        better="lower",
        good=float(du.get("video_dup_good", 0.35)) * 100,
        bad=float(du.get("video_dup_bad", 0.70)) * 100,
        digits=0,
        so_what="A moving arm never produces identical images; repeats while moving are camera stalls (USB bandwidth).",
        action="check camera bandwidth and hubs",
    )

    cameras = _camera_table(report)
    grasp_points = [
        g
        for r in report.episodes
        for h in r.hard
        if h.id == "diversity"
        for g in (h.metrics.get("grasp_pos_m") or [])
        if isinstance(g, list) and len(g) == 3
    ][:3000]
    counts = Counter(i["status"] for i in b.indicators)
    return {
        "groups": [{"id": g, "title": t, "intro": intro} for g, t, intro in GROUPS],
        "indicators": b.indicators,
        "cameras": cameras,
        "grasp_points": grasp_points,
        "status_counts": dict(counts),
        "headline": _headline(b.indicators, report),
    }


def _camera_table(report: DatasetReport) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, list[float]]] = {}
    for r in report.episodes:
        for h in r.hard:
            for k, v in h.metrics.items():
                if not isinstance(v, (int, float)) or isinstance(v, bool):
                    continue
                for prefix, name in (
                    ("brightness.", "brightness"),
                    ("clip_high.", "clip_high"),
                    ("clip_low.", "clip_low"),
                    ("sharpness_p10.", "sharpness_p10"),
                    ("video_dup_rate.", "dup_rate"),
                    ("video_dup_rate_moving.", "dup_rate_moving"),
                ):
                    if k.startswith(prefix):
                        cam = k[len(prefix) :]
                        rows.setdefault(cam, {}).setdefault(name, []).append(float(v))
    out = []
    for cam, cols in rows.items():
        short = cam.split(".")[-2] if cam.endswith(".color") else cam.split(".")[-1]
        out.append({"camera": cam, "short": short, **{k: float(np.median(v)) for k, v in cols.items()}})
    return out


def _headline(indicators: list[dict[str, Any]], report: DatasetReport) -> str:
    """One paragraph: the bad and warn indicators of the session, worst first."""
    order = {"bad": 0, "warn": 1}
    notable = sorted(
        (i for i in indicators if i["status"] in order), key=lambda i: (order[i["status"]], i["group"])
    )
    if not notable:
        return "No session-level indicator is outside its normal range."

    def _part(i: dict[str, Any]) -> str:
        unit = f" {i['unit']}" if i["unit"] and i["unit"] not in ("%", "×") else i["unit"]
        return f"{i['label'].lower()} {i['display']}{unit}"

    bad = [i for i in notable if i["status"] == "bad"]
    warn = [i for i in notable if i["status"] == "warn"]
    out = []
    if bad:
        out.append(f"{len(bad)} indicator(s) out of range: " + "; ".join(_part(i) for i in bad[:6]))
    if warn:
        out.append(f"{len(warn)} to watch: " + "; ".join(_part(i) for i in warn[:6]))
    return ". ".join(out) + "."


def indicators_by_group(profile: dict[str, Any]) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    inds = profile.get("indicators") or []
    return [(g, [i for i in inds if i["group"] == g["id"]]) for g in profile.get("groups") or []]
