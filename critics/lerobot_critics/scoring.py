"""Weighted aggregation of critic results into an episode verdict."""

from __future__ import annotations

from typing import Literal

import numpy as np
from pydantic import BaseModel, Field

from .critics.base import CriticResult
from .spec.models import ScoringConfig

Verdict = Literal["accept", "review", "reject"]

# Prefix of the reason line a review flag writes; the reports parse the flags back out of it.
REVIEW_CAP_PREFIX = "capped at review by flag(s): "


def robust_z(values: np.ndarray) -> np.ndarray:
    """Median/MAD z-score (1.4826*MAD; mean-abs-dev fallback for quantized metrics). NaNs pass through."""
    vals = np.asarray(values, dtype=float)
    if np.isnan(vals).all():
        return vals
    med = np.nanmedian(vals)
    dev = np.abs(vals - med)
    scale = 1.4826 * np.nanmedian(dev)
    if not np.isfinite(scale) or scale < 1e-9:
        scale = float(np.nanmean(dev))
    if not np.isfinite(scale) or scale < 1e-9:
        return np.zeros_like(vals)
    return (vals - med) / scale


class EpisodeScore(BaseModel):
    episode: int
    hard_score: float | None = None
    soft_score: float | None = None
    total: float | None = None
    verdict: Verdict = "review"
    gates_failed: list[str] = Field(default_factory=list)
    flags: list[str] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)


def mute_flags(flags: list[str] | None, cfg: ScoringConfig) -> list[str]:
    """Drop the flags the spec switched off (``scoring.ignore_flags``).

    A muted flag never reaches a gate, a review cap or a report - the finding is treated as
    if it had not been raised. The score of the critic that raised it is unaffected.
    """
    ignored = set(cfg.ignore_flags)
    return [f for f in (flags or []) if f not in ignored]


def weighted_mean(results: list[CriticResult]) -> float | None:
    num = den = 0.0
    for r in results:
        if r.applicable and r.weight > 0:
            num += r.weight * float(r.score)
            den += r.weight
    return num / den if den > 0 else None


def aggregate(
    episode: int, hard: list[CriticResult], soft: list[CriticResult], cfg: ScoringConfig
) -> EpisodeScore:
    hs = weighted_mean(hard)
    ss = weighted_mean(soft)
    parts, weights = [], []
    if hs is not None:
        parts.append(hs)
        weights.append(cfg.hard_weight)
    if ss is not None:
        parts.append(ss)
        weights.append(cfg.soft_weight)
    total = float(np.average(parts, weights=weights)) if parts and sum(weights) > 0 else None
    gates = [r.id for r in hard + soft if r.gate_failed]
    flags = sorted(set(mute_flags([f for r in hard + soft for f in r.flags], cfg)))
    reasons = [
        e for r in hard + soft for e in r.evidence if r.gate_failed or (r.score is not None and r.score < 0.5)
    ]
    if gates or (set(cfg.reject_flags) & set(flags)):
        verdict: Verdict = "reject"
    elif total is None:
        verdict = "review"
    elif total >= cfg.accept_threshold:
        verdict = "accept"
    elif total >= cfg.review_threshold:
        verdict = "review"
    else:
        verdict = "reject"
    if verdict == "accept" and set(cfg.review_flags) & set(flags):
        verdict = "review"
        reasons.insert(0, REVIEW_CAP_PREFIX + ", ".join(sorted(set(cfg.review_flags) & set(flags))))
    return EpisodeScore(
        episode=episode,
        hard_score=hs,
        soft_score=ss,
        total=total,
        verdict=verdict,
        gates_failed=gates,
        flags=flags,
        reasons=reasons[:12],
    )
