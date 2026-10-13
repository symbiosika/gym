"""VLM providers.

* :class:`GeminiProvider` -- native video understanding via the Gemini API
  (``google-genai``). ``mode='agentic'`` lets the model navigate the video itself
  (Gemini 3.6+/3.7/3.8 Flash); ``mode='static'`` samples 1 fps. Videos < 19 MB go
  inline, larger ones through the Files API.
* :class:`OpenAICompatibleProvider` -- any chat-completions endpoint that accepts
  images (OpenRouter, vLLM on a Jetson, Ollama). Receives sampled JPEG frames.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

INLINE_LIMIT = 19 * 1024 * 1024


@dataclass
class VLMResponse:
    data: dict[str, Any]
    raw_text: str
    model: str
    usage: dict[str, Any]
    latency_s: float
    mode: str
    steps: int = 0  # agentic navigation steps observed


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError(f"no JSON object in VLM response: {text[:200]!r}")
    return json.loads(text[start : end + 1])


class GeminiProvider:
    name = "gemini"

    def __init__(
        self, model: str, api_key: str | None = None, timeout_s: float = 300.0, temperature: float = 0.0
    ):
        from google import genai

        key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY not set")
        self.client = genai.Client(api_key=key, http_options={"timeout": int(timeout_s * 1000)})
        self.model = model
        self.temperature = temperature

    def _video_part(self, video_path: Path, mode: str, fps: float | None):
        from google.genai import types

        size = video_path.stat().st_size
        media_processing = "AGENTIC" if mode == "agentic" else "STATIC"
        vmeta = types.VideoMetadata(fps=fps) if (mode == "static" and fps) else None
        if size <= INLINE_LIMIT:
            return types.Part(
                inline_data=types.Blob(data=video_path.read_bytes(), mime_type="video/mp4"),
                media_processing=media_processing,
                video_metadata=vmeta,
            )
        f = self.client.files.upload(file=str(video_path))
        deadline = time.time() + 300
        while f.state and f.state.name == "PROCESSING" and time.time() < deadline:
            time.sleep(2)
            f = self.client.files.get(name=f.name)
        return types.Part(
            file_data=types.FileData(file_uri=f.uri, mime_type=f.mime_type or "video/mp4"),
            media_processing=media_processing,
            video_metadata=vmeta,
        )

    def judge_video(
        self,
        video_path: Path,
        prompt: str,
        schema: dict[str, Any],
        mode: str = "agentic",
        static_fps: float | None = 1.0,
    ) -> VLMResponse:
        from google.genai import types

        part = self._video_part(video_path, mode, static_fps)
        t0 = time.time()
        resp = self.client.models.generate_content(
            model=self.model,
            contents=[types.Content(role="user", parts=[part, types.Part.from_text(text=prompt)])],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=schema,
                temperature=self.temperature,
            ),
        )
        latency = time.time() - t0
        text = resp.text or ""
        steps = 0
        try:
            for cand in resp.candidates or []:
                for p in cand.content.parts or []:
                    if (
                        getattr(p, "tool_call", None) is not None
                        or getattr(p, "function_call", None) is not None
                    ):
                        steps += 1
        except Exception:  # noqa: BLE001
            pass
        um = resp.usage_metadata
        usage = {
            "prompt_tokens": getattr(um, "prompt_token_count", None),
            "output_tokens": getattr(um, "candidates_token_count", None),
            "thought_tokens": getattr(um, "thoughts_token_count", None),
            "tool_use_tokens": getattr(um, "tool_use_prompt_token_count", None),
            "total_tokens": getattr(um, "total_token_count", None),
        }
        return VLMResponse(_extract_json(text), text, self.model, usage, latency, mode, steps)

    def judge_frames(
        self, frames: list[tuple[float, np.ndarray]], prompt: str, schema: dict[str, Any]
    ) -> VLMResponse:
        from google.genai import types

        parts = []
        for t, img in frames:
            parts.append(types.Part.from_text(text=f"[frame at t={t:.1f}s]"))
            parts.append(types.Part(inline_data=types.Blob(data=_jpeg(img), mime_type="image/jpeg")))
        parts.append(types.Part.from_text(text=prompt))
        t0 = time.time()
        resp = self.client.models.generate_content(
            model=self.model,
            contents=[types.Content(role="user", parts=parts)],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=schema,
                temperature=self.temperature,
            ),
        )
        um = resp.usage_metadata
        usage = {"total_tokens": getattr(um, "total_token_count", None)}
        return VLMResponse(
            _extract_json(resp.text or ""), resp.text or "", self.model, usage, time.time() - t0, "frames"
        )


def _jpeg(img: np.ndarray, quality: int = 85) -> bytes:
    import cv2

    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return buf.tobytes()


class OpenAICompatibleProvider:
    """OpenRouter / vLLM / Ollama chat-completions with image inputs (frames mode)."""

    name = "openai_compatible"

    def __init__(
        self,
        model: str,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_s: float = 300.0,
        temperature: float = 0.0,
    ):
        import httpx

        self.base_url = (
            base_url or os.environ.get("OPENAI_BASE_URL") or "https://openrouter.ai/api/v1"
        ).rstrip("/")
        self.api_key = (
            api_key or os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
        )
        self.model = model
        self.temperature = temperature
        self.client = httpx.Client(timeout=timeout_s)

    def judge_frames(
        self, frames: list[tuple[float, np.ndarray]], prompt: str, schema: dict[str, Any]
    ) -> VLMResponse:
        from .prompts import schema_as_text

        content: list[dict[str, Any]] = []
        for t, img in frames:
            content.append({"type": "text", "text": f"[frame at t={t:.1f}s]"})
            b64 = base64.b64encode(_jpeg(img)).decode()
            content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
        content.append({"type": "text", "text": prompt + "\n\n" + schema_as_text(schema)})
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": content}],
            "temperature": self.temperature,
            "response_format": {"type": "json_object"},
        }
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        if "openrouter" in self.base_url:
            headers["HTTP-Referer"] = "https://github.com/symbiosika/gym"
            headers["X-Title"] = "lerobot-critics"
        t0 = time.time()
        r = self.client.post(f"{self.base_url}/chat/completions", json=body, headers=headers)
        if r.status_code >= 400:
            raise RuntimeError(f"VLM endpoint {r.status_code}: {r.text[:500]}")
        js = r.json()
        text = js["choices"][0]["message"]["content"]
        return VLMResponse(
            _extract_json(text),
            text,
            js.get("model", self.model),
            js.get("usage", {}),
            time.time() - t0,
            "frames",
        )

    def judge_video(self, *a, **k):  # pragma: no cover
        raise NotImplementedError("video input is only supported by the gemini provider; use mode='frames'")


def make_provider(cfg) -> GeminiProvider | OpenAICompatibleProvider | None:
    """Build the provider from a :class:`~lerobot_critics.spec.models.VLMConfig`."""
    if cfg.provider == "none":
        return None
    key = os.environ.get(cfg.api_key_env) if cfg.api_key_env else None
    if cfg.provider == "gemini":
        return GeminiProvider(cfg.model, api_key=key, timeout_s=cfg.timeout_s, temperature=cfg.temperature)
    return OpenAICompatibleProvider(
        cfg.model, base_url=cfg.base_url, api_key=key, timeout_s=cfg.timeout_s, temperature=cfg.temperature
    )
