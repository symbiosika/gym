"""Image quality: exposure, clipping, blur, resolution."""

from __future__ import annotations

import numpy as np

from ...dataset.loader import EpisodeContext
from ...dataset.scan import scan_episode
from ..base import HardCritic, band, ramp, ramp_high
from ..registry import register


@register
class ImageQualityCritic(HardCritic):
    id = "image_quality"
    description = (
        "Per camera: mean brightness inside [dark, bright] band, fraction of clipped (blown-out / black) pixels, "
        "Laplacian sharpness (blur/defocus), and frame size vs the declared shape. Worst camera drives the score."
    )
    default_params = {
        "brightness_lo": 50.0,  # 0..255 mean gray
        "brightness_hi": 200.0,
        "brightness_margin": 40.0,
        "clip_high_good": 0.05,  # fraction of pixels > 245
        "clip_high_bad": 0.30,
        "clip_low_good": 0.10,  # fraction of pixels < 10
        "clip_low_bad": 0.50,
        "sharpness_good": 150.0,  # Laplacian variance p10 (half-res gray)
        "sharpness_bad": 30.0,
        "cameras": None,
    }
    relative_flags = {"neg_sharpness_min": ("BLUR_OUTLIER", +1)}

    def evaluate(self, ep: EpisodeContext):
        cams = self.p("cameras") or ep.cameras
        if not cams:
            return self.result(None, error="dataset has no cameras")
        scan = scan_episode(ep, cams)
        m: dict = {}
        flags: list[str] = []
        ev: list[str] = []
        cam_scores: list[float] = []
        sharp_min = None
        for c in cams:
            sc = scan.get(c)
            if not sc or sc["frames"] == 0:
                continue
            b = sc["brightness_mean"]
            parts = [
                band(
                    b,
                    self.p("brightness_lo"),
                    self.p("brightness_hi"),
                    self.p("brightness_margin"),
                    self.p("brightness_margin"),
                ),
                ramp(sc["clip_high_frac"], self.p("clip_high_good"), self.p("clip_high_bad")),
                ramp(sc["clip_low_frac"], self.p("clip_low_good"), self.p("clip_low_bad")),
                ramp_high(sc["sharpness_p10"], self.p("sharpness_good"), self.p("sharpness_bad")),
            ]
            parts = [p for p in parts if p is not None]
            s = min(parts) if parts else None
            m[f"brightness.{c}"] = b
            m[f"clip_high.{c}"] = sc["clip_high_frac"]
            m[f"clip_low.{c}"] = sc["clip_low_frac"]
            m[f"sharpness_p10.{c}"] = sc["sharpness_p10"]
            m[f"size.{c}"] = [sc["width"], sc["height"]]
            feat = ep.ds.features.get(c)
            if feat and len(feat.shape) == 3 and (sc["height"], sc["width"]) != tuple(feat.shape[:2]):
                flags.append("SIZE_MISMATCH")
                ev.append(
                    f"{c}: {sc['width']}x{sc['height']} but info.json says {feat.shape[1]}x{feat.shape[0]}"
                )
            if b > self.p("brightness_hi") + self.p("brightness_margin") or (
                sc["clip_high_frac"] is not None and sc["clip_high_frac"] > self.p("clip_high_bad")
            ):
                flags.append("OVEREXPOSED")
                ev.append(
                    f"{c}: mean brightness {b:.0f}, {100 * (sc['clip_high_frac'] or 0):.0f}% blown-out pixels"
                )
            if b < self.p("brightness_lo") - self.p("brightness_margin"):
                flags.append("UNDEREXPOSED")
                ev.append(f"{c}: mean brightness {b:.0f}")
            if sc["sharpness_p10"] < self.p("sharpness_bad"):
                flags.append("BLUR")
                ev.append(f"{c}: sharpness p10 {sc['sharpness_p10']:.0f}")
            if s is not None:
                cam_scores.append(s)
            sharp_min = sc["sharpness_p10"] if sharp_min is None else min(sharp_min, sc["sharpness_p10"])
        if not cam_scores:
            return self.result(None, m, error="no decodable camera")
        m["neg_sharpness_min"] = -sharp_min if sharp_min is not None else None
        score = 0.5 * min(cam_scores) + 0.5 * float(np.mean(cam_scores))
        return self.result(score, m, sorted(set(flags)), ev)
