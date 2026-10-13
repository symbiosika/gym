"""One decode pass over all cameras of an episode, in lockstep.

Produces per-camera frame statistics (duplicates, exposure, sharpness) used by
the duplication and image-quality critics, and optionally feeds frames to a
:class:`~lerobot_critics.video_composite.CompositeWriter` so the VLM composite
video is produced from the same pass.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .loader import EpisodeContext


@dataclass
class CameraScan:
    camera: str
    frames: int = 0
    exact_dup: int = 0
    near_dup: int = 0
    longest_dup_run: int = 0
    brightness: list[float] = field(default_factory=list)
    clip_low: list[float] = field(default_factory=list)
    clip_high: list[float] = field(default_factory=list)
    sharpness: list[float] = field(default_factory=list)
    dup_mask: list[bool] = field(default_factory=list)  # per frame: near-duplicate of the previous frame
    width: int = 0
    height: int = 0

    def summary(self) -> dict[str, Any]:
        n = max(self.frames - 1, 1)
        b = np.array(self.brightness) if self.brightness else np.array([np.nan])
        s = np.array(self.sharpness) if self.sharpness else np.array([np.nan])
        return {
            "frames": self.frames,
            "width": self.width,
            "height": self.height,
            "exact_dup_rate": self.exact_dup / n,
            "near_dup_rate": self.near_dup / n,
            "longest_dup_run": self.longest_dup_run,
            "brightness_mean": float(np.nanmean(b)),
            "brightness_p5": float(np.nanpercentile(b, 5)),
            "brightness_p95": float(np.nanpercentile(b, 95)),
            "clip_low_frac": float(np.mean(self.clip_low)) if self.clip_low else None,
            "clip_high_frac": float(np.mean(self.clip_high)) if self.clip_high else None,
            "sharpness_mean": float(np.nanmean(s)),
            "sharpness_p10": float(np.nanpercentile(s, 10)),
        }


def scan_episode(
    ep: EpisodeContext,
    cameras: list[str] | None = None,
    near_dup_eps: float = 0.5,
    stats_every: int = 5,
    composite=None,
) -> dict[str, dict[str, Any]]:
    """Decode every frame of the given cameras once. Cached in ``ep.cache['scan']``.

    ``near_dup_eps`` is the mean absolute gray-level difference (on an 8x
    down-sampled thumbnail) below which two consecutive frames count as the same
    camera image repeated by the control loop (re-encoding destroys exact equality).
    """
    key = "scan"
    if key in ep.cache and composite is None:
        return ep.cache[key]
    import cv2

    cams = cameras or ep.cameras
    scans = {c: CameraScan(c) for c in cams}
    prev: dict[str, np.ndarray | None] = {c: None for c in cams}
    cur_run: dict[str, int] = {c: 0 for c in cams}
    iters = {c: ep.frames(c, gray=False) for c in cams}
    idx = 0
    while True:
        frames: dict[str, np.ndarray] = {}
        for c, it in iters.items():
            try:
                _, img = next(it)
                frames[c] = img
            except StopIteration:
                pass
        if not frames:
            break
        for c, img in frames.items():
            sc = scans[c]
            gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            sc.height, sc.width = gray.shape[:2]
            thumb = gray[::8, ::8].astype(np.int16)
            p = prev[c]
            is_dup = False
            if p is not None:
                if np.array_equal(thumb, p):
                    sc.exact_dup += 1
                diff = float(np.abs(thumb - p).mean())
                if diff < near_dup_eps:
                    is_dup = True
                    sc.near_dup += 1
                    cur_run[c] += 1
                    sc.longest_dup_run = max(sc.longest_dup_run, cur_run[c])
                else:
                    cur_run[c] = 0
            sc.dup_mask.append(is_dup)
            prev[c] = thumb
            if idx % stats_every == 0:
                small = gray[::2, ::2]
                sc.brightness.append(float(small.mean()))
                sc.clip_low.append(float((small < 10).mean()))
                sc.clip_high.append(float((small > 245).mean()))
                sc.sharpness.append(float(cv2.Laplacian(small, cv2.CV_64F).var()))
            sc.frames += 1
        if composite is not None and len(frames) == len(cams):
            composite.write(idx, [frames[c] for c in cams])
        idx += 1
    if composite is not None:
        composite.close()
    out = {c: {**sc.summary(), "dup_mask": np.array(sc.dup_mask, dtype=bool)} for c, sc in scans.items()}
    ep.cache[key] = out
    return out
