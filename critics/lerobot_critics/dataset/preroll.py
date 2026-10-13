"""The pre-roll of an episode: the leading span in which the arm command is all zero while
the robot state is valid.

An evaluation stack starts recording before the policy takes over, a teleop stack before
the operator's device is connected: for the first seconds the action topic carries zeros
and the state topic the resting robot. Read naively, those frames are dropout frames (they
drag the normalisation range to 0), a tracking error of a metre, a frozen command stream
and, where the real command begins, a physically impossible jump. None of that is a
property of the episode. The signal critics therefore measure from the first real command
(:func:`signal_start`) and the normalisation critic reports the delay.

A span shorter than ``robot.preroll_min_s`` is not a start-up delay but a dropout (one
all-zero frame at the start of a recording) and is left to the normalisation critic.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

from .loader import EpisodeContext

if TYPE_CHECKING:  # pragma: no cover
    from ..dataset.features import RobotFeatures
    from ..spec.models import CriticSpec


def preroll_frames(ep: EpisodeContext, rf: RobotFeatures, min_s: float | None) -> int:
    """Leading frames in which every arm action feature (cartesian xyz or joints; the hand
    excluded, an open hand is legitimately zero) is exactly zero, when that span lasts at
    least ``min_s``; else 0. A span that covers the whole episode is not a pre-roll (there is
    nothing after it) and is left to the other critics."""
    if not min_s or min_s <= 0:
        return 0
    pairs = [
        p for p in (rf.active_pairs or rf.pairs) if p.kind in ("cartesian", "joints") and ep.has(p.action)
    ]
    if not pairs:
        return 0
    lead: int | None = None
    for p in pairs:
        a = ep.array(p.action)
        x = a[:, :3] if p.kind == "cartesian" else a
        zero = np.abs(x).sum(1) == 0
        nonzero = np.flatnonzero(~zero)
        run = int(nonzero[0]) if len(nonzero) else len(zero)
        lead = run if lead is None else min(lead, run)
    if lead is None or lead >= ep.length or lead < max(1, int(round(float(min_s) * ep.fps))):
        return 0
    return lead


def signal_start(ep: EpisodeContext, spec: CriticSpec, rf: RobotFeatures | None = None) -> int:
    """The first frame the signal critics measure from: the end of the pre-roll, or 0.
    Computed once per episode and shared through ``ep.cache``."""
    if "preroll" not in ep.cache:
        if rf is None:
            from .features import detect_features

            rf = ep.cache.get("features") or detect_features(ep.ds, spec, ep)
            ep.cache["features"] = rf
        ep.cache["preroll"] = preroll_frames(ep, rf, spec.robot.preroll_min_s)
    return int(ep.cache["preroll"])
