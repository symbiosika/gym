"""Multi-camera composite video with burned-in time, for VLM judging.

Layout: the primary camera on top at full size, the other cameras in a row below,
each scaled to fit. Written with ffmpeg (system binary or imageio-ffmpeg) as h264
at a reduced frame rate -- Gemini samples video at ~1 fps in static mode anyway and
navigates it itself in agentic mode, so 5 fps keeps files tiny (~2-3 MB / 80 s).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

from .dataset.video import ffmpeg_exe


def _short(name: str) -> str:
    """'observation.video.humanoid_v1.addons.body_front_camera.color' -> 'body_front'."""
    parts = [
        x for x in name.split(".") if x not in ("color", "rgb", "image", "images", "video", "observation")
    ]
    n = parts[-1] if parts else name
    for tail in ("_camera", "camera_"):
        n = n.replace(tail, "")
    return n[:28] or name[:28]


class CompositeWriter:
    def __init__(
        self,
        out_path: str | Path,
        cameras: list[str],
        primary: str | None,
        src_fps: float,
        out_fps: float = 5.0,
        scale: float = 1.0,
        crf: int = 28,
    ):
        self.out_path = Path(out_path)
        self.cameras = cameras
        self.primary = primary if primary in cameras else cameras[0]
        self.others = [c for c in cameras if c != self.primary]
        self.src_fps = src_fps
        self.out_fps = min(out_fps, src_fps)
        self.every = max(1, int(round(src_fps / self.out_fps)))
        self.scale = scale
        self.crf = crf
        self._proc: subprocess.Popen | None = None
        self._size: tuple[int, int] | None = None
        self.frames_written = 0

    def _layout(self, imgs: list[np.ndarray]) -> np.ndarray:
        import cv2

        prim = imgs[self.cameras.index(self.primary)]
        if self.scale != 1.0:
            prim = cv2.resize(prim, (int(prim.shape[1] * self.scale), int(prim.shape[0] * self.scale)))
        W = prim.shape[1] - (prim.shape[1] % 2)
        prim = prim[:, :W]
        tiles = []
        if self.others:
            tw = W // len(self.others)
            tw -= tw % 2
            for c in self.others:
                im = imgs[self.cameras.index(c)]
                th = int(round(im.shape[0] * tw / im.shape[1]))
                th -= th % 2
                tiles.append(cv2.resize(im, (tw, th), interpolation=cv2.INTER_AREA))
        th = max((t.shape[0] for t in tiles), default=0)
        H = prim.shape[0] + th
        canvas = np.zeros((H, W, 3), np.uint8)
        canvas[: prim.shape[0], :] = prim
        x = 0
        for t in tiles:
            canvas[prim.shape[0] : prim.shape[0] + t.shape[0], x : x + t.shape[1]] = t
            x += t.shape[1]
        return canvas

    def write(self, frame_idx: int, imgs: list[np.ndarray]) -> None:
        if frame_idx % self.every:
            return
        import cv2

        canvas = self._layout(imgs)
        t = frame_idx / self.src_fps
        font = cv2.FONT_HERSHEY_SIMPLEX
        label = f"{_short(self.primary)}  t={t:6.2f}s  f={frame_idx}"
        cv2.putText(canvas, label, (8, 22), font, 0.6, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(canvas, label, (8, 22), font, 0.6, (255, 255, 0), 2, cv2.LINE_AA)
        if self.others:
            prim_h = canvas.shape[0]
            # locate tile row top: primary height = first tile y
            y0 = self._prim_h(imgs)
            tw = canvas.shape[1] // len(self.others)
            for i, c in enumerate(self.others):
                cv2.putText(canvas, _short(c), (i * tw + 8, y0 + 20), font, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
                cv2.putText(
                    canvas, _short(c), (i * tw + 8, y0 + 20), font, 0.5, (255, 255, 0), 1, cv2.LINE_AA
                )
            del prim_h
        if self._proc is None:
            self._open(canvas.shape[1], canvas.shape[0])
        assert self._proc is not None and self._proc.stdin is not None
        if (canvas.shape[1], canvas.shape[0]) != self._size:
            canvas = cv2.resize(canvas, self._size)
        self._proc.stdin.write(canvas.tobytes())
        self.frames_written += 1

    def _prim_h(self, imgs: list[np.ndarray]) -> int:
        prim = imgs[self.cameras.index(self.primary)]
        return int(prim.shape[0] * self.scale) if self.scale != 1.0 else prim.shape[0]

    def _open(self, w: int, h: int) -> None:
        self.out_path.parent.mkdir(parents=True, exist_ok=True)
        self._size = (w, h)
        cmd = [
            ffmpeg_exe(),
            "-y",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{w}x{h}",
            "-r",
            f"{self.out_fps}",
            "-i",
            "-",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            str(self.crf),
            "-movflags",
            "+faststart",
            str(self.out_path),
        ]
        self._proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def close(self) -> None:
        if self._proc is None:
            return
        _, err = self._proc.communicate(timeout=600)  # closes stdin, waits for the encoder
        if self._proc.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {err.decode(errors='replace')[-800:]}")
        self._proc = None
