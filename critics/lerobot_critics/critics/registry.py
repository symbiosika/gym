"""Registry of hard critics keyed by id."""

from __future__ import annotations

from ..spec.models import CriticSpec
from .base import HardCritic

HARD_CRITICS: dict[str, type[HardCritic]] = {}
_LOADED = False


def register(cls: type[HardCritic]) -> type[HardCritic]:
    HARD_CRITICS[cls.id] = cls
    return cls


def _load_builtin() -> None:
    global _LOADED
    if _LOADED:
        return
    _LOADED = True
    from .hard import (  # noqa: F401
        diversity,
        duplication,
        duration,
        grasp_cycles,
        image_quality,
        integrity,
        normalization,
        sensor_limits,
        smoothness,
        tracking_error,
        tremor,
    )


def get_hard_critic(cid: str) -> type[HardCritic]:
    _load_builtin()
    try:
        return HARD_CRITICS[cid]
    except KeyError as e:
        raise KeyError(f"unknown hard critic '{cid}'. Known: {sorted(HARD_CRITICS)}") from e


def list_hard_critics() -> list[dict]:
    _load_builtin()
    return [
        {"id": c.id, "description": c.description, "default_params": c.default_params}
        for c in sorted(HARD_CRITICS.values(), key=lambda c: c.id)
    ]


def build_hard_critics(spec: CriticSpec) -> list[HardCritic]:
    _load_builtin()
    return [get_hard_critic(c.id)(c, spec) for c in spec.hard_critics if c.enabled]
