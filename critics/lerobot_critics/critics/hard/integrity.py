"""Integrity: does the episode's bookkeeping agree with itself?"""

from __future__ import annotations

import numpy as np

from ...dataset.loader import EpisodeContext
from ..base import HardCritic
from ..registry import register


@register
class IntegrityCritic(HardCritic):
    id = "integrity"
    description = (
        "Parquet length vs meta length, contiguous frame_index, monotonic timestamps at the nominal fps, "
        "NaN/inf in numeric features, and video frame count per camera vs parquet length."
    )
    default_params = {
        "video_frame_tolerance": 2,  # frames of allowed |video - parquet| mismatch
        "exact_video_count": False,  # decode fully to count frames (slow, exact); default uses container metadata
        "dt_tolerance_frac": 0.5,  # gap > (1+frac)/fps counts as a timestamp gap
        "check_videos": True,
    }

    def evaluate(self, ep: EpisodeContext) -> None:  # type: ignore[override]
        flags: list[str] = []
        ev: list[str] = []
        m: dict = {}
        n = ep.length
        m["length"] = n
        m["meta_length"] = ep.meta.length
        if n != ep.meta.length:
            flags.append("LENGTH_MISMATCH")
            ev.append(f"parquet has {n} rows, meta says {ep.meta.length}")
        if n == 0:
            return self.result(0.0, m, flags + ["EMPTY"], ev)

        if ep.has("frame_index"):
            fi = ep.df["frame_index"].to_numpy()
            if not np.array_equal(fi, np.arange(len(fi))):
                flags.append("FRAME_INDEX_GAPS")
                ev.append("frame_index is not 0..N-1")
        ts = ep.timestamps()
        m["timestamp_gaps"] = 0
        if ts is not None and len(ts) > 2:
            dt = np.diff(ts)
            nominal = 1.0 / ep.fps
            gaps = int((dt > nominal * (1 + self.p("dt_tolerance_frac"))).sum())
            m["timestamp_gaps"] = gaps
            m["dt_max_s"] = float(dt.max())
            m["timestamps_synthetic"] = bool(np.allclose(dt, nominal, atol=1e-4))
            if (dt <= 0).any():
                flags.append("TIMESTAMPS_NOT_MONOTONIC")
            if gaps:
                flags.append("TIMESTAMP_GAPS")
                ev.append(f"{gaps} timestamp gaps, max dt {dt.max():.3f}s")

        nan_feats = []
        for k in ep.ds.numeric_keys:
            if ep.has(k):
                arr = ep.array(k)
                if not np.isfinite(arr).all():
                    nan_feats.append(k)
        m["nan_features"] = nan_feats
        if nan_feats:
            flags.append("NAN_VALUES")
            ev.append(f"non-finite values in {nan_feats}")

        video_mismatch = []
        if self.p("check_videos"):
            for cam in ep.cameras:
                path = ep.video_path(cam)
                if not path.is_file():
                    video_mismatch.append(cam)
                    flags.append("VIDEO_MISSING")
                    ev.append(f"missing video file for {cam}")
                    continue
                if ep.ds.video_window(ep.index, cam) is not None and not self.p("exact_video_count"):
                    continue  # packed file: container count covers many episodes
                if self.p("exact_video_count"):
                    from ...dataset.video import count_frames

                    vf = count_frames(path)
                else:
                    vf = ep.video_info(cam).frames
                m[f"video_frames.{cam}"] = vf
                if vf and abs(vf - n) > int(self.p("video_frame_tolerance")):
                    video_mismatch.append(cam)
                    ev.append(f"{cam}: {vf} video frames vs {n} parquet rows")
        if video_mismatch and "VIDEO_MISSING" not in flags:
            flags.append("VIDEO_FRAME_MISMATCH")
        m["video_mismatch_cameras"] = video_mismatch

        score = 1.0
        if "VIDEO_MISSING" in flags or "NAN_VALUES" in flags or "EMPTY" in flags:
            score = 0.0
        elif (
            "VIDEO_FRAME_MISMATCH" in flags
            or "LENGTH_MISMATCH" in flags
            or "TIMESTAMPS_NOT_MONOTONIC" in flags
        ):
            score = 0.3
        elif "TIMESTAMP_GAPS" in flags or "FRAME_INDEX_GAPS" in flags:
            score = 0.7
        return self.result(score, m, flags, ev)
