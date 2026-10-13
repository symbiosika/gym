"""Human-readable documentation of every metric the hard critics emit.

Each critic writes numbers into ``CriticResult.metrics``. This module says, for every
metric key, **what** is measured and **how** it is computed, in one or two English
sentences an operator can read without opening the code. The docs are used by

* ``report.md`` / ``report_ai.md`` (metric glossary section),
* ``episodes.csv`` (companion ``episodes_columns.csv`` describing every column),
* ``report.json`` (``metric_docs`` for the metrics that occur in the run),
* the REST API (``GET /metrics``) and the web UI (description column in the metrics view),
* the CLI (``lerobot-critics metrics``).

Metric keys come in two shapes: a plain key (``pos_err_mean_mm``) or a key with a feature
or camera suffix (``pos_err_mean_mm.action.humanoid_v1.left_wrist``, ``brightness.<camera>``).
:func:`describe_metric` resolves the suffixed form to its base entry. Keys starting with
``_`` are private intermediates (used by dataset-level summaries) and are not documented
or exported. ``z.<metric>`` is the robust z-score of that metric across the run.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

Better = str  # "lower" | "higher" | "info" | "target"


@dataclass(frozen=True)
class MetricDoc:
    key: str
    critic: str
    label: str
    unit: str
    what: str
    how: str
    better: Better = "info"  # lower / higher / info / target (a specific value is expected)
    per_feature: bool = False  # the key carries a ``.<feature>`` or ``.<camera>`` suffix

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


_DOCS: list[MetricDoc] = []


def _m(
    critic: str,
    key: str,
    label: str,
    unit: str,
    what: str,
    how: str,
    better: Better = "info",
    per_feature: bool = False,
) -> None:
    _DOCS.append(MetricDoc(key, critic, label, unit, what, how, better, per_feature))


# ---------------------------------------------------------------- integrity
_m(
    "integrity",
    "length",
    "Frames",
    "frames",
    "Number of rows (frames) in the episode's parquet slice.",
    "len(parquet)",
)
_m(
    "integrity",
    "meta_length",
    "Declared length",
    "frames",
    "Frames the dataset metadata claims for this episode.",
    "meta/episodes.jsonl length field.",
    "target",
)
_m(
    "integrity",
    "timestamp_gaps",
    "Timestamp gaps",
    "count",
    "Frames whose timestamp jumped by more than 1.5 frames at the nominal fps.",
    "Count of diff(timestamp) > (1 + dt_tolerance_frac) / fps.",
    "lower",
)
_m(
    "integrity",
    "dt_max_s",
    "Largest timestamp step",
    "s",
    "The biggest gap between two consecutive timestamps.",
    "max(diff(timestamp))",
    "lower",
)
_m(
    "integrity",
    "timestamps_synthetic",
    "Synthetic timestamps",
    "bool",
    "True when every timestamp step equals exactly 1/fps, i.e. timestamps were generated from the frame index and carry no timing information.",
    "allclose(diff(timestamp), 1/fps)",
)
_m(
    "integrity",
    "nan_features",
    "Features with NaN/inf",
    "list",
    "Numeric features containing non-finite values.",
    "isfinite check over every numeric feature.",
    "lower",
)
_m(
    "integrity",
    "video_frames",
    "Video frames",
    "frames",
    "Frames in the camera's video file (container metadata unless exact_video_count is set).",
    "ffprobe / exact decode count.",
    "target",
    True,
)
_m(
    "integrity",
    "video_mismatch_cameras",
    "Cameras with frame mismatch",
    "list",
    "Cameras whose video frame count differs from the parquet length by more than the tolerance.",
    "|video_frames - length| > video_frame_tolerance",
    "lower",
)

# ---------------------------------------------------------------- duration
_m("duration", "duration_s", "Duration", "s", "Episode length in seconds.", "frames / fps", "target")
_m(
    "duration",
    "neg_duration_s",
    "Negated duration",
    "s",
    "Helper: -duration_s, so that the dataset-relative SHORT_OUTLIER flag can use the common 'higher = outlier' rule.",
    "-duration_s",
)
_m("duration", "frames", "Frames", "frames", "Episode length in frames.", "len(parquet)")
_m("duration", "fps", "Frame rate", "Hz", "Nominal frame rate of the dataset.", "meta/info.json fps")
_m(
    "duration",
    "min_s",
    "Configured minimum",
    "s",
    "Lower bound of the accepted duration band (after per_cycle scaling).",
    "params.min_s",
)
_m(
    "duration",
    "max_s",
    "Configured maximum",
    "s",
    "Upper bound of the accepted duration band.",
    "params.max_s",
)

# ---------------------------------------------------------------- smoothness
_m(
    "smoothness",
    "ldj_median",
    "Log-dimensionless jerk",
    "log",
    "How fluid the commanded motion is; less negative = smoother. Fluid cartesian teleop lands around -14 to -15.",
    "Median over 3 s windows with motion of -log( duration^5 / v_peak^2 * integral(jerk^2) ) of the command position.",
    "higher",
)
_m(
    "smoothness",
    "ldj_median.",
    "Log-dimensionless jerk per feature",
    "log",
    "Windowed LDJ for one arm/feature.",
    "See ldj_median.",
    "higher",
    True,
)
_m(
    "smoothness",
    "neg_ldj_median",
    "Negated LDJ",
    "log",
    "Helper: -ldj_median for the JERKY_OUTLIER rule (higher = jerkier).",
    "-ldj_median",
)
_m(
    "smoothness",
    "hf_ratio",
    "High-frequency energy share (>2.5 Hz)",
    "fraction",
    "Share of the command speed profile's energy above 2.5 Hz. Tremor, noise and twitchy corrections push it up.",
    "FFT of the speed profile; sum of power at f >= hf_cutoff_hz divided by total power (DC removed).",
    "lower",
)
_m(
    "smoothness",
    "hf_ratio.",
    "High-frequency energy share per feature",
    "fraction",
    "hf_ratio for one arm/feature.",
    "See hf_ratio.",
    "lower",
    True,
)
_m(
    "smoothness",
    "spikes",
    "Command spikes",
    "count",
    "Single-frame command jumps that are physically implausible (acceleration > 25 m/s² or > 1 m/s in one frame): transport glitches flattened into the training targets.",
    "Count of frames where the finite-difference acceleration or speed of the command exceeds spike_accel_mps2 / spike_speed_mps.",
    "lower",
)
_m(
    "smoothness",
    "spikes.",
    "Command spikes per feature",
    "count",
    "Spikes for one feature.",
    "See spikes.",
    "lower",
    True,
)
_m(
    "smoothness",
    "spike_rate_per_min",
    "Spike rate",
    "1/min",
    "Command spikes normalised by episode length.",
    "spikes / duration_min",
    "lower",
)
_m(
    "smoothness",
    "accel_max.",
    "Peak command acceleration",
    "m/s²",
    "Largest finite-difference acceleration of the commanded position.",
    "max |d²x/dt²| of the action position.",
    "lower",
    True,
)
_m(
    "smoothness",
    "hesitation_s",
    "Longest pause",
    "s",
    "Longest span inside the motion (between first and last movement) where the command did not change.",
    "Longest run of per-frame command change < still_eps.",
    "lower",
)
_m(
    "smoothness",
    "speed_p95",
    "Speed p95",
    "m/s",
    "95th percentile of the commanded end-effector speed: how fast the operator moved.",
    "np.percentile(|v|, 95) of the command position.",
)

# ---------------------------------------------------------------- tracking_error
_m(
    "tracking_error",
    "pos_err_raw_mean_mm.",
    "Raw position error",
    "mm",
    "Mean distance between commanded and measured position WITHOUT lag compensation. Contains the pure latency effect, so it is large during fast motion.",
    "mean |action_xyz - state_xyz| over the episode.",
    "lower",
    True,
)
_m(
    "tracking_error",
    "pos_err_mean_mm.",
    "Position error (lag-compensated)",
    "mm",
    "Mean distance between command and measured position after shifting the state back by the estimated follower lag. What remains is controller damping / real tracking error, not latency.",
    "mean |action_xyz[t] - state_xyz[t + lag]|",
    "lower",
    True,
)
_m(
    "tracking_error",
    "pos_err_mean_mm",
    "Position error, worst active arm",
    "mm",
    "Lag-compensated mean position error of the worst active arm (drives the score and the outlier flag).",
    "max over active arms of pos_err_mean_mm.<feature>",
    "lower",
)
_m(
    "tracking_error",
    "pos_err_p95_mm.",
    "Position error p95 (lag-compensated)",
    "mm",
    "95th percentile of the lag-compensated position error.",
    "np.percentile(err, 95)",
    "lower",
    True,
)
_m(
    "tracking_error",
    "lag_err_share.",
    "Error explained by latency",
    "fraction",
    "Share of the raw position error that disappears when the state is shifted by the lag. 0.75 means three quarters of the visible command-vs-robot gap is pure delay, the rest is damping.",
    "1 - pos_err_mean_mm / pos_err_raw_mean_mm",
    "info",
    True,
)
_m(
    "tracking_error",
    "lag_err_share",
    "Error explained by latency, slowest active arm",
    "fraction",
    "lag_err_share of the arm that reports lag_ms (the slowest active arm).",
    "value of lag_err_share.<feature> for the slowest active arm",
    "info",
)
_m(
    "tracking_error",
    "rot_err_mean_deg.",
    "Orientation error",
    "deg",
    "Mean geodesic angle between commanded and measured end-effector orientation (rot6d, quaternion or euler), lag-compensated.",
    "mean angle(R_action^T R_state)",
    "lower",
    True,
)
_m(
    "tracking_error",
    "stall_s.",
    "Longest not-following span",
    "s",
    "Longest stretch where the position error stayed above stall_mm: the follower did not move although it was commanded to.",
    "Longest run of err > stall_mm, in seconds.",
    "lower",
    True,
)
_m(
    "tracking_error",
    "lag_frames.",
    "Follower lag",
    "frames",
    "Integer delay between command and robot: the state shift that minimises |action - state|. Only accepted when it removes at least 10 % of the error.",
    "argmin over shifts 0..max_lag of mean |action[t] - state[t+shift]|.",
    "lower",
    True,
)
_m(
    "tracking_error",
    "lag_xcorr_frames.",
    "Follower lag (cross-correlation)",
    "frames",
    "Sub-frame estimate of the command-to-state delay from the cross-correlation of the command and state velocities (velocities give a sharp peak, positions do not).",
    "Peak of corr(v_action[t], v_state[t+k]) over k, refined by parabolic interpolation around the peak.",
    "lower",
    True,
)
_m(
    "tracking_error",
    "lag_ms.",
    "Follower lag",
    "ms",
    "The cross-correlation lag in milliseconds. This is the delay between the recorded command topic and the recorded state topic (IK, controller, transport). Everything before the command topic (VR tracking, network) is NOT included.",
    "lag_xcorr_frames / fps * 1000",
    "lower",
    True,
)
_m(
    "tracking_error",
    "lag_corr.",
    "Lag correlation peak",
    "0..1",
    "How well the shifted state velocity matches the command velocity. Near 1 = the robot reproduces the command faithfully after the delay; low values mean heavy filtering or a poor lag estimate.",
    "Normalised cross-correlation at the best lag.",
    "higher",
    True,
)
_m(
    "tracking_error",
    "lag_ms",
    "Follower lag, worst active arm",
    "ms",
    "Cross-correlation latency of the slowest-following active arm (dataset statistics use this).",
    "max over active arms of lag_ms.<feature>",
    "lower",
)
_m(
    "tracking_error",
    "hand_err_norm.",
    "Hand tracking error",
    "fraction of range",
    "Mean |action - state| of the hand/gripper, normalised by its range.",
    "mean |a - s| / range",
    "lower",
    True,
)
_m(
    "tracking_error",
    "joint_err_norm_mean.",
    "Joint tracking error (mean)",
    "fraction of range",
    "Mean normalised |action - state| over all moving joints.",
    "mean over joints of mean |a - s| / range",
    "lower",
    True,
)
_m(
    "tracking_error",
    "joint_err_norm_worst.",
    "Joint tracking error (worst joint)",
    "fraction of range",
    "Largest per-joint normalised error.",
    "max over joints of mean |a - s| / range",
    "lower",
    True,
)

# ---------------------------------------------------------------- duplication
_m(
    "duplication",
    "video_dup_rate.",
    "Repeated frames (raw)",
    "fraction",
    "Share of consecutive frames that are near-identical, over the whole episode. A rig property (USB bandwidth, static scene).",
    "mean |gray_t - gray_(t-1)| on 8x thumbnails < near_dup_eps",
    "lower",
    True,
)
_m(
    "duplication",
    "video_dup_rate_moving.",
    "Repeated frames while moving",
    "fraction",
    "Share of repeated frames restricted to frames where the robot moved. A moving arm never produces identical images, so this is a real camera stall.",
    "dup_mask & moving_mask, divided by moving frames.",
    "lower",
    True,
)
_m(
    "duplication",
    "video_dup_run_moving.",
    "Longest camera freeze while moving",
    "frames",
    "Longest run of repeated frames while the robot moved.",
    "longest_run(dup_mask & moving_mask)",
    "lower",
    True,
)
_m(
    "duplication",
    "video_dup_rate_max",
    "Worst camera repeat rate while moving",
    "fraction",
    "Maximum over cameras of video_dup_rate_moving.",
    "max over cameras",
    "lower",
)
_m(
    "duplication",
    "video_dup_run_max_s",
    "Longest camera freeze while moving",
    "s",
    "Longest frozen run on the wrist (run_cameras) cameras while the robot moved.",
    "longest run / fps",
    "lower",
)
_m(
    "duplication",
    "all_cams_dup_run_s",
    "All cameras frozen",
    "s",
    "Longest span where every camera repeated its frame at the same time: a pipeline stall.",
    "longest_run(AND over cameras of dup_mask) / fps",
    "lower",
)
_m(
    "duplication",
    "action_dup_rate",
    "Frozen command rate",
    "fraction",
    "Share of frames whose whole command vector is identical to the previous frame: the teleop stream stalled.",
    "mean(diff(action) == 0 over all dims)",
    "lower",
)
_m(
    "duplication",
    "action_dup_run_s",
    "Longest frozen command",
    "s",
    "Longest run of identical consecutive command vectors.",
    "longest_run / fps",
    "lower",
)
_m(
    "duplication",
    "state_dup_rate",
    "Frozen state rate",
    "fraction",
    "Share of frames whose whole state vector is identical to the previous frame.",
    "mean(diff(state) == 0 over all dims)",
    "lower",
)
_m(
    "duplication",
    "state_dup_run_s",
    "Longest frozen state",
    "s",
    "Longest run of identical consecutive state vectors.",
    "longest_run / fps",
    "lower",
)

# ---------------------------------------------------------------- image_quality
_m(
    "image_quality",
    "brightness.",
    "Mean brightness",
    "0..255",
    "Average gray level of the camera over the episode.",
    "mean of per-frame mean(gray)",
    "target",
    True,
)
_m(
    "image_quality",
    "clip_high.",
    "Blown-out pixels",
    "fraction",
    "Share of pixels brighter than 245: over-exposure, glare, reflections (a white glossy table, sunlight on a tray).",
    "mean(gray > 245) over sampled frames",
    "lower",
    True,
)
_m(
    "image_quality",
    "clip_low.",
    "Black pixels",
    "fraction",
    "Share of pixels darker than 10: under-exposure or back-light (a wrist camera looking into a window darkens the object).",
    "mean(gray < 10) over sampled frames",
    "lower",
    True,
)
_m(
    "image_quality",
    "sharpness_p10.",
    "Sharpness p10",
    "Laplacian var",
    "10th percentile of the per-frame Laplacian variance: how blurry the blurriest 10 % of frames are (motion blur, defocus).",
    "np.percentile(var(Laplacian(gray_halfres)), 10)",
    "higher",
    True,
)
_m(
    "image_quality",
    "neg_sharpness_min",
    "Negated minimum sharpness",
    "Laplacian var",
    "Helper: -min over cameras of sharpness_p10, for the BLUR_OUTLIER rule.",
    "-min(sharpness_p10.<camera>)",
)
_m(
    "image_quality",
    "size.",
    "Frame size",
    "px",
    "Decoded [width, height] of the camera.",
    "from the first decoded frame",
    "target",
    True,
)

# ---------------------------------------------------------------- sensor_limits
_m(
    "sensor_limits",
    "limit_violation.",
    "Limit violation",
    "fraction",
    "Share of frames where the dimension lies outside its configured [min, max].",
    "mean((x < lo) | (x > hi))",
    "lower",
    True,
)
_m(
    "sensor_limits",
    "dead_zone_frac.",
    "Dead-zone dwell",
    "fraction",
    "Share of frames where the value rests inside a configured dead zone.",
    "mean((x >= lo) & (x <= hi))",
    "lower",
    True,
)
_m(
    "sensor_limits",
    "saturation",
    "Saturation runs",
    "list",
    "Every dimension that stayed pinned at its own min or max for longer than saturation_run_s: feature, dim, which extreme, run length.",
    "runs of |x - extreme| <= saturation_eps_frac * range",
)
_m(
    "sensor_limits",
    "saturation_run_max_s",
    "Longest saturation run",
    "s",
    "Longest time a dimension stayed pinned at its own extreme (clamp or stuck sensor).",
    "longest run of |x - extreme| <= eps / fps",
    "lower",
)

# ---------------------------------------------------------------- grasp_cycles
_m(
    "grasp_cycles",
    "n_cycles",
    "Grasp cycles",
    "count",
    "Close→open cycles of the hand that carried the object (wrist moved ≥ min_carry while closed). One task repetition = one cycle.",
    "Hysteresis on the smoothed closure signal, idle closures removed, re-grasps within merge_gap_s merged.",
    "target",
)
_m(
    "grasp_cycles",
    "gripper_feature",
    "Closure signal",
    "feature",
    "The state feature (and dims) used as the hand/gripper closure signal.",
    "robot.gripper or auto-detected",
)
_m(
    "grasp_cycles",
    "expected_cycles",
    "Expected cycles",
    "count",
    "Repetitions per episode from task.expected_cycles.",
    "spec",
)
_m(
    "grasp_cycles",
    "swing",
    "Closure swing",
    "signal units",
    "Difference between the 98th and 2nd percentile of the closure signal: how far the hand actually opens and closes.",
    "p98 - p2 of the smoothed closure signal",
)
_m(
    "grasp_cycles",
    "closed_frac",
    "Time closed",
    "fraction",
    "Share of the episode with the hand more than half closed.",
    "mean(signal > lo + 0.5 swing)",
)
_m(
    "grasp_cycles",
    "hold_s",
    "Hold durations",
    "s",
    "How long the object was held in each cycle (grasp to release).",
    "(release - grasp) / fps per cycle",
)
_m(
    "grasp_cycles",
    "grasp_frames",
    "Grasp keyframes",
    "frame",
    "Frame index where each grasp closed.",
    "hysteresis crossing",
)
_m(
    "grasp_cycles",
    "release_frames",
    "Release keyframes",
    "frame",
    "Frame index where each grasp opened again (null = still closed at the end).",
    "hysteresis crossing",
)
_m(
    "grasp_cycles",
    "regrasps",
    "Re-grasps",
    "count",
    "Closures that re-closed within merge_gap_s of a release: fumbles inside one attempt.",
    "merged cycle count",
    "lower",
)
_m(
    "grasp_cycles",
    "idle_closures",
    "Idle closures",
    "count",
    "Hand closures during which the wrist did not carry anything (operator squeezing while waiting). Not counted as attempts.",
    "closures with carry < min_carry",
    "lower",
)
_m(
    "grasp_cycles",
    "carry",
    "Carry distance",
    "m",
    "How far the wrist moved from the grasp pose while the hand was closed, per cycle.",
    "max |state_xyz - state_xyz[grasp]| during the hold",
)
_m(
    "grasp_cycles",
    "close_dur_s",
    "Closing duration",
    "s",
    "How long each closing takes from open (15 % of swing) to closed (85 % of swing). Slow closings mean hesitant or careful grasping; from the commanded hand signal when available.",
    "frames between the 15 % and 85 % crossings around each grasp keyframe / fps",
)
_m(
    "grasp_cycles",
    "close_dur_median_s",
    "Closing duration (median)",
    "s",
    "Median of close_dur_s over the cycles.",
    "median",
)
_m(
    "grasp_cycles",
    "wrist_move_during_close_mm",
    "Wrist motion while closing",
    "mm",
    "Distance the wrist travelled while the hand was closing, per cycle. A clean grasp stops first and then closes (a few mm); large values mean grasping on the move or correcting during the close.",
    "|state_xyz[close_end] - state_xyz[close_start]|",
    "lower",
)
_m(
    "grasp_cycles",
    "wrist_move_during_close_median_mm",
    "Wrist motion while closing (median)",
    "mm",
    "Median of wrist_move_during_close_mm over the cycles.",
    "median",
    "lower",
)
_m(
    "grasp_cycles",
    "settle_before_close_s",
    "Settle time before closing",
    "s",
    "How long the wrist was already slow (< 3 cm/s) before the hand started closing. 0 = the operator closed while still approaching.",
    "run of command speed < 0.03 m/s immediately before close_start / fps",
)
_m(
    "grasp_cycles",
    "settle_before_close_median_s",
    "Settle time before closing (median)",
    "s",
    "Median of settle_before_close_s over the cycles.",
    "median",
)
_m(
    "grasp_cycles",
    "cycle_gap_s",
    "Gap between cycles",
    "s",
    "Time from one release to the next grasp: reset / waiting phases inside the episode (a person re-placing the object, the arm returning).",
    "(grasp[i+1] - release[i]) / fps",
)
_m(
    "grasp_cycles",
    "active_frac",
    "Active time",
    "fraction",
    "Share of the episode where the active arm's command moved faster than 2 cm/s. Low values mean long waiting phases the policy will learn as 'do nothing'.",
    "mean(|v_action| > 0.02 m/s)",
)

# ---------------------------------------------------------------- tremor
_m(
    "tremor",
    "hf5_share_cmd",
    "Command energy above 5 Hz",
    "fraction",
    "Share of the COMMAND velocity power above 5 Hz (of everything above 0.3 Hz). Human hand tremor sits at 8–12 Hz; a large share here means the operator's input device transmits it and the policy will learn it as target.",
    "Welch PSD (256-sample Hann segments) of the command velocity per axis, summed; power(f > 5 Hz) / power(f > 0.3 Hz). Worst active arm.",
    "lower",
)
_m(
    "tremor",
    "hf5_share_state",
    "Robot energy above 5 Hz",
    "fraction",
    "Same as hf5_share_cmd for the measured robot state. Much smaller than the command share = the robot's controller filters the tremor; similar = the robot itself vibrates.",
    "Welch PSD of the state velocity.",
    "lower",
)
_m(
    "tremor",
    "hf5_share_cmd.",
    "Command energy above 5 Hz per feature",
    "fraction",
    "hf5_share_cmd for one arm.",
    "See hf5_share_cmd.",
    "lower",
    True,
)
_m(
    "tremor",
    "hf5_share_state.",
    "Robot energy above 5 Hz per feature",
    "fraction",
    "hf5_share_state for one arm.",
    "See hf5_share_state.",
    "lower",
    True,
)
_m(
    "tremor",
    "tremor_peak_hz_cmd",
    "Dominant tremor frequency",
    "Hz",
    "Frequency of the strongest command-velocity peak above 3 Hz. 8–12 Hz = physiological hand tremor from a hand-held or hand-tracked input device.",
    "argmax of the command velocity PSD for f > 3 Hz.",
)
_m(
    "tremor",
    "tremor_peak_hz_cmd.",
    "Dominant tremor frequency per feature",
    "Hz",
    "tremor_peak_hz_cmd for one arm.",
    "See tremor_peak_hz_cmd.",
    "info",
    True,
)
_m(
    "tremor",
    "tremor_source",
    "Where the tremor comes from",
    "label",
    "'input_device' when the command carries clearly more high-frequency energy than the robot state (the robot filters it: fix the teleop input), 'robot' when the state carries as much or more (mechanical vibration / controller), 'none' when both are low.",
    "ratio of hf5_share_cmd to hf5_share_state against thresholds",
)
_m(
    "tremor",
    "hold_segments",
    "Hold phases",
    "count",
    "Number of phases ≥ 1 s where the commanded speed stayed below 5 cm/s (approach end, grasp, release, waiting).",
    "runs of |v_action| < hold_speed_mps longer than hold_min_s",
)
_m(
    "tremor",
    "hold_total_s",
    "Time in hold phases",
    "s",
    "Total duration of the hold phases.",
    "sum of run lengths / fps",
)
_m(
    "tremor",
    "hold_jitter_cmd_mm",
    "Command jitter while holding still",
    "mm",
    "Standard deviation of the commanded position (linear trend removed) inside hold phases: how much the 'still' hand actually wobbles in the command.",
    "std of the detrended 3-D command position, mean over hold segments, ×1000",
    "lower",
)
_m(
    "tremor",
    "hold_jitter_state_mm",
    "Robot jitter while holding still",
    "mm",
    "Same as hold_jitter_cmd_mm for the measured robot position.",
    "std of the detrended state position inside hold phases",
    "lower",
)
_m(
    "tremor",
    "hold_rms_speed_cmd_mms",
    "Command speed while holding still",
    "mm/s",
    "RMS speed of the command inside hold phases. A truly still hand gives a few mm/s; 15–25 mm/s means the command never rests and the policy learns to fidget at the grasp.",
    "sqrt(mean(|v_action|²)) over hold frames ×1000",
    "lower",
)
_m(
    "tremor",
    "hold_rms_speed_state_mms",
    "Robot speed while holding still",
    "mm/s",
    "Same as hold_rms_speed_cmd_mms for the measured state.",
    "sqrt(mean(|v_state|²)) over hold frames ×1000",
    "lower",
)
_m(
    "tremor",
    "rot_speed_p95_cmd_deg_s",
    "Commanded rotation speed p95",
    "deg/s",
    "95th percentile of the commanded end-effector angular speed. High values with a low state value = rotational noise in the input device.",
    "geodesic angle between consecutive command orientations × fps, p95",
    "lower",
)
_m(
    "tremor",
    "rot_speed_p95_state_deg_s",
    "Measured rotation speed p95",
    "deg/s",
    "Same as rot_speed_p95_cmd_deg_s for the robot state.",
    "geodesic angle between consecutive state orientations × fps, p95",
    "lower",
)
_m(
    "tremor",
    "finger_cmd_speed_p95",
    "Finger command speed p95",
    "units/s",
    "95th percentile of the summed absolute change of the hand/gripper command per second: twitchy finger commands between grasps.",
    "p95 of sum |diff(hand_action)| × fps",
    "lower",
)

# ---------------------------------------------------------------- normalization
_m(
    "normalization",
    "zero_frames",
    "All-zero pose frames",
    "count",
    "Frames where a cartesian position is exactly (0, 0, 0) or a whole joint/hand vector is exactly 0 while its neighbours are not: a transport dropout. A single such frame drags the dataset's min/max normalisation range to 0 and destroys the action resolution for the whole training run.",
    "count of rows with |x|.sum() == 0 (cartesian: xyz only)",
    "lower",
)
_m(
    "normalization",
    "zero_frames.",
    "All-zero frames per feature",
    "count",
    "zero_frames for one feature (with the first frame indices in zero_frame_index.<feature>).",
    "See zero_frames.",
    "lower",
    True,
)
_m(
    "normalization",
    "zero_frame_index.",
    "Where the zero frames are",
    "frame",
    "Frame indices (first few) of the all-zero rows of this feature.",
    "np.where",
    "info",
    True,
)
_m(
    "normalization",
    "dead_dims.",
    "Constant dimensions",
    "list",
    "Dimensions of this action feature that never change inside the episode (range < 1e-6): they carry no information for the policy (e.g. an unused thumb yaw). Dataset-wide list in the run summary.",
    "ptp(x) < 1e-6 per dimension",
    "info",
    True,
)
_m(
    "normalization",
    "idle_arm_path_m.",
    "Idle arm drift path",
    "m",
    "Distance the state of an arm that is NOT doing the task (robot.active_arms) travelled during the episode. Should be ~0 for a parked arm; metres per episode mean the operator's other hand leaks into the action space as noise.",
    "sum |diff(state_xyz)|",
    "lower",
    True,
)
_m(
    "normalization",
    "idle_arm_path_m_per_min",
    "Idle arm drift rate",
    "m/min",
    "Worst idle arm's path length normalised by episode duration (drives the score).",
    "max over idle arms of idle_arm_path_m / duration_min",
    "lower",
)
_m(
    "normalization",
    "idle_hand_range.",
    "Idle hand range",
    "signal units",
    "Largest per-dimension range of an idle arm's hand/gripper signal. Should be ~0 for a parked hand.",
    "max over dims of ptp(hand_state)",
    "lower",
    True,
)
_m(
    "normalization",
    "action_equals_state.",
    "Action is a copy of state",
    "bool",
    "True when the action of this feature never differs from the state by more than 1 % of its range: the 'command' is a readback, not an operator intent, and carries no lead over the robot.",
    "max |a - s| / range < 0.01",
    "info",
    True,
)

# ---------------------------------------------------------------- diversity
_m(
    "diversity",
    "n_grasps",
    "Grasps in this episode",
    "count",
    "Grasp keyframes used for the workspace statistics.",
    "from grasp_cycles",
)
_m(
    "diversity",
    "grasp_pos_m",
    "Grasp positions",
    "m",
    "Wrist position (x, y, z) of the active arm at each grasp keyframe: where the object was picked.",
    "state_xyz[grasp_frame]",
)
_m(
    "diversity",
    "release_pos_m",
    "Release positions",
    "m",
    "Wrist position at each release keyframe: where the object was placed.",
    "state_xyz[release_frame]",
)
_m(
    "diversity",
    "wrist_feature",
    "Wrist feature",
    "feature",
    "The cartesian state feature whose xyz is sampled at the keyframes.",
    "first active cartesian pair (elbows excluded)",
)
_m("diversity", "end_pos_m", "End pose", "m", "Wrist position in the last frame.", "state_xyz[-1]")
_m("diversity", "start_pos_m", "Start pose", "m", "Wrist position in the first frame.", "state_xyz[0]")
_m(
    "diversity",
    "grasp_offset_from_median_cm",
    "Grasp offset from the dataset median",
    "cm",
    "Largest distance of this episode's grasp positions from the median grasp position of the whole run. Episodes far from the median are the ones that add spatial variation; a run where every episode is < 2 cm from the median has essentially one object position.",
    "max over grasps |grasp_pos - median_grasp_pos| ×100 (dataset-relative, filled in after all episodes)",
    "higher",
)

# ---------------------------------------------------------------- lookup
METRIC_DOCS: dict[tuple[str, str], MetricDoc] = {(_d.critic, _d.key): _d for _d in _DOCS}


def describe_metric(critic: str, key: str) -> MetricDoc | None:
    """Doc for ``key`` as emitted by ``critic``; suffixed keys resolve to their base entry.

    ``z.<key>`` (robust z-score) returns a synthesized doc. Private ``_`` keys return None.
    """
    if key.startswith("_"):
        return None
    if key.startswith("z."):
        base = describe_metric(critic, key[2:])
        label = base.label if base else key[2:]
        return MetricDoc(
            key,
            critic,
            f"z-score of {label}",
            "robust z",
            f"How unusual this episode's {label} is compared with the other episodes of the run.",
            "(x - median) / (1.4826 * MAD) across the run; > z_cut raises the *_OUTLIER flag.",
            "info",
        )
    d = METRIC_DOCS.get((critic, key))
    if d is not None:
        return d
    parts = key.split(".")
    for i in range(len(parts) - 1, 0, -1):
        base = ".".join(parts[:i])
        d = METRIC_DOCS.get((critic, base + "."))
        if d is not None:
            return d
        d = METRIC_DOCS.get((critic, base))
        if d is not None and d.per_feature:
            return d
    return None


def feature_suffix(critic: str, key: str) -> str | None:
    """The ``<feature>`` part of a suffixed key, or None for a plain key."""
    d = describe_metric(critic, key)
    if d is None or not d.per_feature:
        return None
    base = d.key.rstrip(".")
    if key.startswith(base + "."):
        return key[len(base) + 1 :]
    return None


def all_metric_docs(critic: str | None = None) -> list[dict[str, Any]]:
    docs = [d for d in _DOCS if critic is None or d.critic == critic]
    return [d.as_dict() for d in docs]


def docs_for_metrics(present: dict[str, set[str]]) -> dict[str, dict[str, Any]]:
    """``{critic: {metric keys}}`` -> ``{"critic.key": doc}`` for every documented key present."""
    out: dict[str, dict[str, Any]] = {}
    for critic, keys in present.items():
        for k in sorted(keys):
            d = describe_metric(critic, k)
            if d is None:
                continue
            entry = d.as_dict()
            entry["key"] = k
            feat = feature_suffix(critic, k)
            if feat:
                entry["feature"] = feat
            out[f"{critic}.{k}"] = entry
    return out


def undocumented_metrics(present: dict[str, set[str]]) -> list[str]:
    """Metric keys (``critic.key``) that have no documentation - used by the tests."""
    return [
        f"{critic}.{k}"
        for critic, keys in present.items()
        for k in sorted(keys)
        if not k.startswith("_") and describe_metric(critic, k) is None
    ]
