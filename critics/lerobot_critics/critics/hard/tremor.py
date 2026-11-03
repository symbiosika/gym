"""Tremor and hold jitter: does the operator's input device shake, and does the command
ever come to rest?

Motivation (a long-horizon cup→tray dataset, September 2026): the commanded wrist velocity carried ~12 % of
its power above 5 Hz with a peak at 10 Hz - physiological hand tremor from the teleop input
device - while the robot state carried only ~3 % (the controller filters it). During
"still" phases the command still moved at ~19 mm/s RMS. A policy trained on the raw command
learns exactly that fidgeting as its target at the grasp.
"""

from __future__ import annotations

import numpy as np

from ...dataset.features import detect_features
from ...dataset.loader import EpisodeContext
from ...dataset.preroll import signal_start
from ..base import HardCritic, ramp
from ..registry import register
from ._util import (
    band_share,
    detrended_std,
    highpass_rms,
    orientation_error_deg,
    runs,
    spectral_peak,
    welch_psd,
)


def _rot_speed_deg_s(a: np.ndarray, fps: float) -> np.ndarray | None:
    if len(a) < 3:
        return None
    ang = orientation_error_deg(a[1:], a[:-1])
    if ang is None:
        return None
    return ang * fps


@register
class TremorCritic(HardCritic):
    id = "tremor"
    description = (
        "Tremor and hold jitter of the teleop command, split between the input device and the robot: "
        "share of command vs state velocity power above 5 Hz (Welch PSD) and the dominant tremor frequency "
        "(8-12 Hz = human hand tremor), where the tremor originates, and how much the command still moves "
        "inside hold phases (command speed < 5 cm/s for >= 1 s): detrended position jitter and RMS speed, "
        "plus commanded vs measured rotation speed and finger command speed. The flag needs a share AND an "
        "amplitude: the RMS of the command position above 5 Hz in millimetres."
    )
    default_params = {
        "hf_cutoff_hz": 5.0,  # tremor band starts here (human tremor 8-12 Hz; 2.5 Hz is the smoothness cutoff)
        "psd_floor_hz": 0.3,  # power below this (slow reaching) is excluded from the denominator
        "nperseg": 256,
        "hf_good": 0.05,  # command share above the cutoff: full score (clean teleop < 5 %)
        "hf_bad": 0.35,  # zero score
        "flag_share": 0.20,  # TREMOR when the command share exceeds this AND the peak lies in peak_band_hz
        "flag_amp_mm": 3.0,  # ... AND the command shakes by more than this (RMS of the > 5 Hz motion, mm)
        "amp_good_mm": 2.0,  # amplitude ramp: full score
        "amp_bad_mm": 5.0,  # zero score
        "peak_band_hz": [6.0, 14.0],
        "source_ratio": 2.0,  # cmd amplitude / state amplitude above this = the input device is the source
        "hold_speed_mps": 0.05,
        "hold_min_s": 1.0,
        "hold_rms_good_mms": 5.0,  # RMS command speed while 'still'
        "hold_rms_bad_mms": 40.0,
    }
    relative_flags = {
        "hf5_share_cmd": ("TREMOR_OUTLIER", +1),
        "hold_rms_speed_cmd_mms": ("TREMOR_OUTLIER", +1),
    }

    def evaluate(self, ep: EpisodeContext):
        rf = ep.cache.get("features") or detect_features(ep.ds, self.spec, ep)
        ep.cache["features"] = rf
        pairs = [p for p in rf.active_pairs if p.kind == "cartesian"] or [
            p for p in rf.pairs if p.kind == "cartesian"
        ]
        pairs = [p for p in pairs if "elbow" not in p.action.lower()]
        if not pairs:
            return self.result(None, error="no cartesian arm action/state pair (tremor needs xyz)")
        st = signal_start(ep, self.spec, rf)
        fps = ep.fps
        cutoff = float(self.p("hf_cutoff_hz"))
        floor = float(self.p("psd_floor_hz"))
        nperseg = int(self.p("nperseg"))
        m: dict = {}
        hf_cmd: list[float] = []
        hf_state: list[float] = []
        amp_cmd: list[float] = []
        amp_state: list[float] = []
        peaks: list[float] = []
        hold_jit_c: list[float] = []
        hold_jit_s: list[float] = []
        hold_rms_c: list[float] = []
        hold_rms_s: list[float] = []
        hold_n = 0
        hold_total = 0.0
        rot_c: list[float] = []
        rot_s: list[float] = []
        for p in pairs:
            a, s = ep.array(p.action)[st:], ep.array(p.state)[st:]
            if a.shape != s.shape or len(a) < 32:
                continue
            ok = (np.abs(a[:, :3]).sum(1) > 0) & (np.abs(s[:, :3]).sum(1) > 0)  # drop all-zero dropouts
            a, s = a[ok], s[ok]
            if len(a) < 32:
                continue
            ac, as_ = highpass_rms(a[:, :3], fps, cutoff), highpass_rms(s[:, :3], fps, cutoff)
            if ac is not None:
                amp_cmd.append(ac * 1000.0)
                m[f"hf_pos_rms_cmd_mm.{p.action}"] = ac * 1000.0
            if as_ is not None:
                amp_state.append(as_ * 1000.0)
                m[f"hf_pos_rms_state_mm.{p.action}"] = as_ * 1000.0
            va = np.diff(a[:, :3], axis=0) * fps
            vs = np.diff(s[:, :3], axis=0) * fps
            fa, pa = welch_psd(va, fps, nperseg)
            fs_, ps = welch_psd(vs, fps, nperseg)
            hc = band_share(fa, pa, cutoff, floor)
            hs = band_share(fs_, ps, cutoff, floor)
            pk = spectral_peak(fa, pa, 3.0)
            if hc is not None:
                hf_cmd.append(hc)
                m[f"hf5_share_cmd.{p.action}"] = hc
            if hs is not None:
                hf_state.append(hs)
                m[f"hf5_share_state.{p.action}"] = hs
            if pk is not None:
                peaks.append(pk)
                m[f"tremor_peak_hz_cmd.{p.action}"] = pk
            # hold phases: command speed below threshold for >= hold_min_s
            spa = np.linalg.norm(va, axis=1)
            sps = np.linalg.norm(vs, axis=1)
            slow = spa < float(self.p("hold_speed_mps"))
            min_len = int(round(float(self.p("hold_min_s")) * fps))
            for r0, r1 in runs(slow):
                if r1 - r0 < max(min_len, 3):
                    continue
                hold_n += 1
                hold_total += (r1 - r0) / fps
                hold_jit_c.append(detrended_std(a[r0 : r1 + 1, :3]) * 1000.0)
                hold_jit_s.append(detrended_std(s[r0 : r1 + 1, :3]) * 1000.0)
                hold_rms_c.append(float(np.sqrt(np.mean(spa[r0:r1] ** 2))) * 1000.0)
                hold_rms_s.append(float(np.sqrt(np.mean(sps[r0:r1] ** 2))) * 1000.0)
            rc = _rot_speed_deg_s(a, fps)
            rs = _rot_speed_deg_s(s, fps)
            if rc is not None and np.isfinite(rc).any():
                rot_c.append(float(np.nanpercentile(rc, 95)))
            if rs is not None and np.isfinite(rs).any():
                rot_s.append(float(np.nanpercentile(rs, 95)))
        if not hf_cmd and not hold_rms_c:
            return self.result(None, m, error="arm signals too short or flat")
        hf_c = max(hf_cmd) if hf_cmd else None
        hf_s = max(hf_state) if hf_state else None
        m["hf5_share_cmd"] = hf_c
        m["hf5_share_state"] = hf_s
        amp_c = max(amp_cmd) if amp_cmd else None
        amp_s = max(amp_state) if amp_state else None
        m["hf_pos_rms_cmd_mm"] = amp_c
        m["hf_pos_rms_state_mm"] = amp_s
        m["tremor_peak_hz_cmd"] = (
            peaks[int(np.argmax(hf_cmd))] if peaks and hf_cmd else (peaks[0] if peaks else None)
        )
        source = "none"
        if hf_c is not None and hf_c > float(self.p("hf_good")):
            if amp_c is not None and amp_s is not None:
                c_val, s_val = amp_c, amp_s
            else:
                c_val, s_val = hf_c, hf_s
            if s_val is None or s_val <= 0 or c_val / max(s_val, 1e-9) >= float(self.p("source_ratio")):
                source = "input_device"
            elif s_val >= c_val:
                source = "robot"
            else:
                source = "mixed"
        m["tremor_source"] = source
        m["hold_segments"] = hold_n
        m["hold_total_s"] = hold_total
        m["hold_jitter_cmd_mm"] = float(np.mean(hold_jit_c)) if hold_jit_c else None
        m["hold_jitter_state_mm"] = float(np.mean(hold_jit_s)) if hold_jit_s else None
        m["hold_rms_speed_cmd_mms"] = float(np.mean(hold_rms_c)) if hold_rms_c else None
        m["hold_rms_speed_state_mms"] = float(np.mean(hold_rms_s)) if hold_rms_s else None
        m["rot_speed_p95_cmd_deg_s"] = max(rot_c) if rot_c else None
        m["rot_speed_p95_state_deg_s"] = max(rot_s) if rot_s else None
        g = rf.gripper
        if g is not None and g.action_feature and ep.has(g.action_feature):
            ha = ep.array(g.action_feature)
            if len(ha) > 2:
                hv = np.abs(np.diff(ha, axis=0)).sum(1) * fps
                m["finger_cmd_speed_p95"] = float(np.percentile(hv, 95))

        parts: list[float] = []
        if hf_c is not None:
            parts.append(ramp(hf_c, float(self.p("hf_good")), float(self.p("hf_bad"))))
        if amp_c is not None:
            parts.append(ramp(amp_c, float(self.p("amp_good_mm")), float(self.p("amp_bad_mm"))))
        if m["hold_rms_speed_cmd_mms"] is not None:
            parts.append(
                ramp(
                    m["hold_rms_speed_cmd_mms"],
                    float(self.p("hold_rms_good_mms")),
                    float(self.p("hold_rms_bad_mms")),
                )
            )
        score = float(np.mean(parts)) if parts else None
        flags: list[str] = []
        ev: list[str] = []
        lo_hz, hi_hz = self.p("peak_band_hz")
        pk = m["tremor_peak_hz_cmd"]
        if (
            hf_c is not None
            and hf_c > float(self.p("flag_share"))
            and amp_c is not None
            and amp_c > float(self.p("flag_amp_mm"))
            and pk is not None
            and lo_hz <= pk <= hi_hz
        ):
            flags.append("TREMOR")
            ev.append(
                f"the command shakes by {amp_c:.1f} mm RMS above {cutoff:g} Hz ({hf_c * 100:.0f}% of its velocity "
                f"power), peak at {pk:.1f} Hz (robot state {amp_s or 0:.1f} mm, {100 * (hf_s or 0):.0f}%) "
                f"-> source: {source}"
            )
        elif hf_c is not None and hf_c > float(self.p("hf_good")) and source == "input_device":
            ev.append(
                f"command carries {hf_c * 100:.0f}% high-frequency velocity power vs {100 * (hf_s or 0):.0f}% in the "
                f"robot state (peak {pk:.1f} Hz): the input device shakes, the robot filters it"
                if pk is not None
                else f"command carries {hf_c * 100:.0f}% high-frequency velocity power vs {100 * (hf_s or 0):.0f}% in the robot state"
            )
        if m["hold_rms_speed_cmd_mms"] is not None and m["hold_rms_speed_cmd_mms"] > float(
            self.p("hold_rms_bad_mms")
        ):
            flags.append("HOLD_JITTER")
            ev.append(
                f"command still moves at {m['hold_rms_speed_cmd_mms']:.0f} mm/s RMS inside {hold_n} hold phases "
                f"({hold_total:.0f}s) - the hand never rests before/while grasping"
            )
        return self.result(score, m, flags, ev)
