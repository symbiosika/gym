"""Video decoding helpers built on PyAV (no system ffmpeg needed for decoding)."""

from __future__ import annotations

import os
import shutil
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class VideoInfo:
    path: str
    frames: int
    fps: float
    width: int
    height: int
    codec: str
    duration_s: float


def ffmpeg_exe() -> str:
    """System ffmpeg if present (Docker/Jetson), else the imageio-ffmpeg bundled binary."""
    exe = os.environ.get("FFMPEG_BINARY") or shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def probe_video(path: str | Path) -> VideoInfo:
    import av

    with av.open(str(path)) as c:
        s = c.streams.video[0]
        rate = float(s.average_rate) if s.average_rate else 0.0
        dur = (
            float(s.duration * s.time_base)
            if s.duration and s.time_base
            else (float(c.duration / 1e6) if c.duration else 0.0)
        )
        n = int(s.frames or 0)
        if n == 0 and dur and rate:
            n = int(round(dur * rate))
        return VideoInfo(str(path), n, rate, int(s.width), int(s.height), s.codec_context.name, dur)


def _resize(img: np.ndarray, max_side: int | None) -> np.ndarray:
    if not max_side:
        return img
    h, w = img.shape[:2]
    scale = max_side / max(h, w)
    if scale >= 1:
        return img
    import cv2

    return cv2.resize(img, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_AREA)


def iter_frames(
    path: str | Path,
    indices: list[int] | None = None,
    step: int = 1,
    gray: bool = False,
    max_side: int | None = None,
    window: tuple[float, float] | None = None,
    fps: float | None = None,
    length: int | None = None,
) -> Iterator[tuple[int, np.ndarray]]:
    """Sequentially decode a video and yield selected frames.

    ``indices`` are episode-relative frame indices; when ``window`` is given (packed
    v3 file) frames before ``window[0]`` are skipped and index 0 is the first frame
    of the window. Sequential decoding is used on purpose: robot videos are short
    and GOP-friendly seeking is unreliable for h264/AV1 with small keyframe spacing.
    """
    import av

    wanted = set(indices) if indices is not None else None
    if wanted is not None and not wanted:
        return
    max_wanted = max(wanted) if wanted else None
    fmt = "gray" if gray else "rgb24"
    with av.open(str(path)) as c:
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        start_s = window[0] if window else 0.0
        if window and start_s > 0.5:
            # seek close to the window start, then discard frames before it
            c.seek(int(start_s / s.time_base) if s.time_base else 0, stream=s, backward=True, any_frame=False)
        rel = -1
        for frame in c.decode(s):
            if window:
                t = float(frame.pts * s.time_base) if frame.pts is not None and s.time_base else None
                if t is not None and t < start_s - 1e-3:
                    continue
                if t is not None and t >= window[1] - 1e-3:
                    break
            rel += 1
            if length is not None and rel >= length:
                break
            if wanted is not None:
                if rel not in wanted:
                    if max_wanted is not None and rel > max_wanted:
                        break
                    continue
            elif step > 1 and rel % step:
                continue
            img = frame.to_ndarray(format=fmt)
            yield rel, _resize(img, max_side)


def count_frames(path: str | Path) -> int:
    """Exact frame count by decoding (slow, but exact -- used by the integrity critic)."""
    import av

    n = 0
    with av.open(str(path)) as c:
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        for _ in c.decode(s):
            n += 1
    return n
