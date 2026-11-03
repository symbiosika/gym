"""The VLM judge: turns an episode + spec into one CriticResult per success indicator."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np

from ...dataset.features import detect_features
from ...dataset.loader import EpisodeContext
from ...dataset.preroll import signal_start
from ...scoring import mute_flags
from ...spec.models import CriticSpec
from ...video_composite import CompositeWriter
from ..base import CriticResult, _jsonable, clamp01
from .prompts import build_prompt, response_schema, short_camera
from .providers import VLMResponse, make_provider

CAMERA_ANOMALIES = ("camera_freeze", "camera_problem", "video_discontinuity")


def _camera_confirmed(hard: list[CriticResult] | None) -> bool:
    """The duplication critic saw a stalled camera: a CAMSTALL, or a camera with over 30% repeated frames."""
    for r in hard or []:
        if r.id != "duplication":
            continue
        if "CAMSTALL" in r.flags:
            return True
        for k, v in r.metrics.items():
            if k.startswith("video_dup_rate.") and isinstance(v, (int, float)) and v > 0.3:
                return True
    return False


def _file_hash(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _layout_text(cameras: list[str], primary: str | None, mode: str = "agentic") -> str:
    """The layout the model is told about. Frames mode draws the camera name on each tile; the
    composite video of the other modes labels the tiles itself."""
    others = [c for c in cameras if c != primary]
    short = short_camera
    if mode == "frames":
        if not others:
            return f"single camera '{short(primary or cameras[0])}'"
        return (
            f"one image per time stamp, the cameras side by side left to right: '{short(primary or cameras[0])}', "
            + ", ".join(f"'{short(c)}'" for c in others)
            + ". The camera name is written on each tile; the top-left text shows the time in seconds."
        )
    if not others:
        return f"single camera '{short(primary or cameras[0])}'"
    return (
        f"top (large): '{short(primary)}' camera; bottom row left-to-right: "
        + ", ".join(f"'{short(c)}'" for c in others)
        + ". Each tile is labelled; the top-left text shows the time in seconds and the frame index."
    )


def ensure_composite(ep: EpisodeContext, spec: CriticSpec, out_dir: Path, fps: float, scale: float) -> Path:
    """Composite video for the VLM (produced together with the frame scan, cached on disk)."""
    from ...dataset.scan import scan_episode

    out = out_dir / "composites" / f"episode_{ep.index:06d}.mp4"
    if out.is_file() and out.stat().st_size > 0:
        return out
    rf = ep.cache.get("features") or detect_features(ep.ds, spec, ep)
    ep.cache["features"] = rf
    writer = CompositeWriter(out, ep.cameras, rf.primary_camera, ep.fps, out_fps=fps, scale=scale)
    scan_episode(ep, ep.cameras, composite=writer)
    return out


def sample_frames(ep: EpisodeContext, spec: CriticSpec, n: int) -> list[tuple[float, np.ndarray]]:
    """Evenly spaced frames plus grasp/release keyframes, tiled per timestamp across cameras."""
    import cv2

    rf = ep.cache.get("features") or detect_features(ep.ds, spec, ep)
    idx = set(np.linspace(0, ep.length - 1, max(n, 2)).astype(int).tolist())
    gc = ep.cache.get("grasp_cycles")
    if gc:
        for c in gc["cycles"]:
            idx.add(int(c["grasp"]))
            if c["release"] is not None:
                idx.add(min(int(c["release"]) + int(ep.fps), ep.length - 1))
    wanted = sorted(idx)
    per_cam = {c: dict(ep.frames(c, indices=wanted, max_side=480)) for c in ep.cameras}
    out = []
    prim = rf.primary_camera or ep.cameras[0]
    for i in wanted:
        named = [(prim, per_cam[prim].get(i))] + [(c, per_cam[c].get(i)) for c in ep.cameras if c != prim]
        named = [(c, t) for c, t in named if t is not None]
        if not named:
            continue
        h = min(t.shape[0] for _, t in named)
        tiles = []
        for c, t in named:
            t = cv2.resize(t, (int(t.shape[1] * h / t.shape[0]), h))
            cv2.putText(t, short_camera(c), (6, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 0), 2)
            tiles.append(t)
        img = np.concatenate(tiles, axis=1)
        cv2.putText(img, f"t={i / ep.fps:.1f}s", (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 0), 2)
        out.append((i / ep.fps, img))
    return out


class VLMJudge:
    def __init__(self, spec: CriticSpec, out_dir: Path):
        self.spec = spec
        self.cfg = spec.soft_critics.vlm
        self.out_dir = Path(out_dir)
        self.cache_dir = self.out_dir / "vlm_cache"
        self.schema = response_schema(spec)
        self._provider = None

    @property
    def provider(self):
        if self._provider is None:
            self._provider = make_provider(self.cfg)
        return self._provider

    def _cache_key(self, ep: EpisodeContext, prompt: str, media_hash: str) -> str:
        payload = json.dumps(
            {
                "ep": ep.index,
                "model": self.cfg.model,
                "mode": self.cfg.mode,
                "prompt": prompt,
                "media": media_hash,
                "schema": self.schema,
            },
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode()).hexdigest()[:24]

    def judge(
        self, ep: EpisodeContext, hard: list[CriticResult] | None = None
    ) -> tuple[dict[str, Any], list[CriticResult]]:
        rf = ep.cache.get("features") or detect_features(ep.ds, self.spec, ep)
        ep.cache["features"] = rf
        mode = self.cfg.mode
        if self.cfg.provider != "gemini" and mode != "frames":
            mode = "frames"
        layout = _layout_text(ep.cameras, rf.primary_camera, mode)
        prompt = build_prompt(
            self.spec,
            ep.cameras,
            rf.primary_camera,
            layout,
            ep.duration_s,
            episode_task=ep.task,
            task_varies=ep.ds.has_varying_tasks,
            preroll_s=signal_start(ep, self.spec, rf) / ep.fps,
            active_arms=self.spec.robot.active_arms,
            camera_arms=rf.camera_arms,
        )
        media_path: Path | None = None
        frames: list[tuple[float, np.ndarray]] = []
        if mode in ("agentic", "static"):
            media_path = ensure_composite(
                ep, self.spec, self.out_dir, self.cfg.composite_fps, self.cfg.composite_scale
            )
            media_hash = _file_hash(media_path)
        else:
            frames = sample_frames(ep, self.spec, self.cfg.frames_per_episode)
            media_hash = hashlib.sha256(b"".join(f.tobytes()[:4096] for _, f in frames)).hexdigest()[:16]
        key = self._cache_key(ep, prompt, media_hash)
        cache_file = self.cache_dir / f"{key}.json"
        if self.cfg.cache and cache_file.is_file():
            payload = json.loads(cache_file.read_text())
            payload["cached"] = True
        else:
            prov = self.provider
            if prov is None:
                raise RuntimeError("VLM provider disabled")
            if mode in ("agentic", "static"):
                resp: VLMResponse = prov.judge_video(media_path, prompt, self.schema, mode=mode)  # type: ignore[arg-type]
            else:
                resp = prov.judge_frames(frames, prompt, self.schema)
            payload = {
                "data": resp.data,
                "model": resp.model,
                "mode": resp.mode,
                "usage": resp.usage,
                "latency_s": resp.latency_s,
                "steps": resp.steps,
                "cached": False,
                "media": str(media_path) if media_path else f"{len(frames)} frames",
            }
            if self.cfg.cache:
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                cache_file.write_text(json.dumps(payload, indent=1))
        return payload, self.to_results(payload, hard)

    def to_results(
        self, payload: dict[str, Any], hard: list[CriticResult] | None = None
    ) -> list[CriticResult]:
        data = payload.get("data", {})
        inds = data.get("indicators", {}) or {}
        results = []
        for ind in self.spec.soft_critics.indicators:
            d = inds.get(ind.id) or {}
            score = d.get("score")
            try:
                score = clamp01(float(score)) if score is not None else None
            except (TypeError, ValueError):
                score = None
            conf = d.get("confidence")
            gate_failed = bool(ind.gate and score is not None and score < ind.gate_below)
            flags = []
            if score is not None and score < 0.5:
                flags.append(f"VLM_{ind.id.upper()}")
            flags = mute_flags(flags, self.spec.scoring)
            results.append(
                CriticResult(
                    id=f"vlm.{ind.id}",
                    kind="soft",
                    weight=ind.weight,
                    score=score,
                    gate=ind.gate,
                    gate_below=ind.gate_below,
                    gate_failed=gate_failed,
                    flags=flags,
                    metrics={"confidence": conf},
                    evidence=[str(d.get("evidence", ""))] if d else [],
                )
            )
        # summary pseudo-result (weight 0: informational, carries anomalies / attempts / task_success)
        anomalies = [dict(a) if isinstance(a, dict) else a for a in (data.get("anomalies") or [])]
        camera_confirmed = _camera_confirmed(hard)
        for a in anomalies:
            if not isinstance(a, dict):
                continue
            if a.get("type") in CAMERA_ANOMALIES and not camera_confirmed:
                # the picture's own freeze or jump is the duplication critic's to confirm
                a["severity"] = "minor" if a.get("severity") in ("major", "minor") else a.get("severity")
                a["unverified"] = True
            elif a.get("type") == "object_drop":
                # the hand state cannot confirm a drop: a person looks
                a["verified"] = False
        major = [a for a in anomalies if isinstance(a, dict) and a.get("severity") == "major"]
        flags = ["VLM_TASK_FAILED"] if data.get("task_success") is False else []
        if major:
            flags.append("VLM_MAJOR_ANOMALY")
        if any(
            isinstance(a, dict) and a.get("type") == "human_in_workspace" and a.get("severity") != "info"
            for a in anomalies
        ):
            flags.append("HUMAN_IN_WORKSPACE")
        flags = mute_flags(flags, self.spec.scoring)
        results.append(
            CriticResult(
                id="vlm.summary",
                kind="soft",
                weight=0.0,
                score=1.0
                if data.get("task_success")
                else (0.0 if data.get("task_success") is False else None),
                flags=flags,
                metrics=_jsonable(
                    {
                        "task_success": data.get("task_success"),
                        "confidence": data.get("confidence"),
                        "attempts": data.get("attempts"),
                        "n_attempts": len(data.get("attempts") or []),
                        "anomalies": anomalies,
                        "model": payload.get("model"),
                        "mode": payload.get("mode"),
                        "usage": payload.get("usage"),
                        "latency_s": payload.get("latency_s"),
                        "agentic_steps": payload.get("steps"),
                        "cached": payload.get("cached"),
                    }
                ),
                evidence=[str(data.get("summary", ""))]
                + [
                    f"{a.get('type')}@{a.get('time_s')}s ({a.get('severity')}): {a.get('description')}"
                    for a in anomalies
                    if isinstance(a, dict)
                ][:10],
            )
        )
        return results


def judge_episode(ep: EpisodeContext, spec: CriticSpec, out_dir: str | Path) -> list[CriticResult]:
    return VLMJudge(spec, Path(out_dir)).judge(ep)[1]
