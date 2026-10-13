"""Auto-detection of robot feature semantics: action/state pairs, cartesian poses,
gripper/hand signals, camera roles. Everything can be overridden in the spec."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np

from ..spec.models import CriticSpec
from .loader import EpisodeContext, LeRobotDataset

CARTESIAN_HINTS = ("wrist", "eef", "ee_pose", "cartesian", "tcp", "pose")
HAND_HINTS = ("hand", "gripper", "finger")


@dataclass
class FeaturePair:
    action: str
    state: str
    names: list[str]
    kind: str  # "cartesian" | "hand" | "joints"
    arm: str | None  # "left" / "right" / None
    active: bool = True


@dataclass
class GripperSignal:
    feature: str
    dims: list[int]
    closed_is_high: bool
    action_feature: str | None = None


@dataclass
class RobotFeatures:
    pairs: list[FeaturePair] = field(default_factory=list)
    gripper: GripperSignal | None = None
    primary_camera: str | None = None
    wrist_cameras: list[str] = field(default_factory=list)
    cameras: list[str] = field(default_factory=list)

    @property
    def active_pairs(self) -> list[FeaturePair]:
        return [p for p in self.pairs if p.active]


def _arm_of(key: str) -> str | None:
    k = key.lower()
    for arm in ("left", "right"):
        if arm in k:
            return arm
    return None


def _representation(ds: LeRobotDataset) -> dict:
    p = ds.root / "meta" / "representation.json"
    if p.is_file():
        try:
            return json.loads(p.read_text())
        except Exception:  # noqa: BLE001
            return {}
    return {}


def _kind(key: str, names: list[str], rep: dict) -> str:
    r = rep.get(key, {})
    if r.get("kind") == "eef_pose" or "xyz" in str(r.get("format", "")):
        return "cartesian"
    lk = key.lower()
    if any(h in lk for h in HAND_HINTS):
        return "hand"
    ln = [n.lower() for n in names]
    if len(ln) >= 3 and ln[:3] == ["x", "y", "z"]:
        return "cartesian"
    if any(h in lk for h in CARTESIAN_HINTS) and len(names) in (3, 6, 7, 9):
        return "cartesian"
    return "joints"


def detect_features(ds: LeRobotDataset, spec: CriticSpec, ep: EpisodeContext | None = None) -> RobotFeatures:
    rep = _representation(ds)
    rf = RobotFeatures(cameras=list(ds.camera_keys))
    keys = set(ds.features)

    # ---- action/state pairs
    mapping: dict[str, str] = {}
    if spec.robot.action_state_pairs:
        mapping = dict(spec.robot.action_state_pairs)
    else:
        for k in keys:
            if k == "action":
                if "observation.state" in keys:
                    mapping[k] = "observation.state"
            elif k.startswith("action."):
                cand = "observation.state." + k[len("action.") :]
                if cand in keys:
                    mapping[k] = cand
    active_arms = [a.lower() for a in spec.robot.active_arms]
    for a, s in sorted(mapping.items()):
        f = ds.features[a]
        names = (
            list(f.names)
            if f.names and isinstance(f.names, list)
            else [str(i) for i in range(f.shape[0] if f.shape else 1)]
        )
        kind = _kind(a, names, rep)
        if spec.robot.cartesian_features and a in spec.robot.cartesian_features:
            kind = "cartesian"
        arm = _arm_of(a)
        active = True if not active_arms else (arm in active_arms if arm else True)
        rf.pairs.append(FeaturePair(a, s, names, kind, arm, active))

    # ---- gripper / hand signal
    g = spec.robot.gripper
    if g.feature and g.feature in keys:
        dims = g.dims
        if dims is None:
            f = ds.features[g.feature]
            dims = list(range(f.shape[0] if f.shape else 1))
        act = (
            "action" + g.feature[len("observation.state") :]
            if g.feature.startswith("observation.state")
            else None
        )
        rf.gripper = GripperSignal(g.feature, dims, g.closed_is_high, act if act in keys else None)
    else:
        rf.gripper = _auto_gripper(ds, rf, active_arms, ep)

    # ---- cameras
    wrist = [c for c in rf.cameras if "wrist" in c.lower() or "gripper" in c.lower() or "hand" in c.lower()]
    rf.wrist_cameras = wrist
    if spec.robot.primary_camera and spec.robot.primary_camera in rf.cameras:
        rf.primary_camera = spec.robot.primary_camera
    else:
        non_wrist = [c for c in rf.cameras if c not in wrist]
        rf.primary_camera = non_wrist[0] if non_wrist else (rf.cameras[0] if rf.cameras else None)
    return rf


def _auto_gripper(
    ds: LeRobotDataset, rf: RobotFeatures, active_arms: list[str], ep: EpisodeContext | None
) -> GripperSignal | None:
    # 1) dedicated hand/gripper state features (prefer active arm, then the one that moves most)
    hand_pairs = [p for p in rf.pairs if p.kind == "hand"]
    if not hand_pairs:
        hand_pairs = [
            FeaturePair(k, k, [], "hand", _arm_of(k), True)
            for k in ds.features
            if k.startswith("observation.state") and any(h in k.lower() for h in HAND_HINTS)
        ]
    if hand_pairs:
        cands = [p for p in hand_pairs if p.active] or hand_pairs
        if len(cands) > 1 and ep is not None:
            cands.sort(
                key=lambda p: -float(np.ptp(ep.array(p.state), axis=0).max()) if ep.has(p.state) else 0.0
            )
        p = cands[0]
        f = ds.features[p.state]
        n = f.shape[0] if f.shape else 1
        names = [x.lower() for x in (f.names or [])]
        # for multi-finger hands skip thumb yaw/pitch (they barely move), use the finger flexion dims
        dims = [i for i, nm in enumerate(names) if ("thumb" not in nm)] if names else list(range(n))
        dims = dims or list(range(n))
        return GripperSignal(p.state, dims, True, p.action if p.action != p.state else None)
    # 2) a gripper dimension inside a joint vector
    for p in rf.pairs:
        idx = [i for i, nm in enumerate(p.names) if "gripper" in nm.lower()]
        if idx:
            # LeRobot SO-100 style: larger value = more open -> closed_is_high False
            return GripperSignal(p.state, idx, False, p.action)
    return None
