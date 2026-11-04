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
    # which arm a wrist camera is mounted on (None for a scene camera)
    camera_arms: dict[str, str | None] = field(default_factory=dict)

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
    rf.camera_arms = {c: (_arm_of(c) if c in wrist else None) for c in rf.cameras}
    if spec.robot.primary_camera and spec.robot.primary_camera in rf.cameras:
        rf.primary_camera = spec.robot.primary_camera
    else:
        non_wrist = [c for c in rf.cameras if c not in wrist]
        rf.primary_camera = non_wrist[0] if non_wrist else (rf.cameras[0] if rf.cameras else None)
    return rf


def _cartesian_pairs(rf: RobotFeatures, only_active: bool) -> list[FeaturePair]:
    src = rf.active_pairs if only_active else rf.pairs
    return [p for p in src if p.kind == "cartesian" and "elbow" not in p.state.lower()]


def gripper_arm_pair(rf: RobotFeatures) -> FeaturePair | None:
    """The wrist pose that belongs to the hand or gripper that grasps.

    The grasp keyframes come from one hand; sampling another arm's wrist at them reads a
    parked arm. Falls back to the first active, then the first, cartesian non-elbow pair.
    """
    if rf.gripper is not None:
        arm = _arm_of(rf.gripper.feature)
        if arm:
            for p in _cartesian_pairs(rf, False):
                if p.arm == arm:
                    return p
    pairs = _cartesian_pairs(rf, True) or _cartesian_pairs(rf, False)
    return pairs[0] if pairs else None


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


def _arm_names(rf: RobotFeatures) -> set[str]:
    return {p.arm for p in rf.pairs if p.arm}


def arm_motion(ds: LeRobotDataset, spec: CriticSpec, n_episodes: int = 5) -> dict[str, float]:
    """Metres of state path per arm over the first ``n_episodes`` episodes.

    Every cartesian non-elbow pair counts, whether the spec names its arm or not: this is
    what the data says about which arm does the work. The path is taken over a short moving
    average and without all-zero rows, so sensor noise on a parked arm does not add up to
    motion. Arms are keyed by the side in the feature name; pairs with no side are skipped.
    """
    from ..critics.hard._util import dropout_rows, smooth

    out: dict[str, float] = {}
    rf = detect_features(ds, spec)
    pairs = [p for p in rf.pairs if p.kind == "cartesian" and p.arm and "elbow" not in p.state.lower()]
    for arm in sorted({p.arm for p in pairs if p.arm}):
        out[arm] = 0.0
    for idx in ds.episode_indices()[: max(1, n_episodes)]:
        ep = ds.episode(idx)
        drop = dropout_rows(ep, rf)
        for p in pairs:
            if not ep.has(p.state):
                continue
            xyz = ep.array(p.state)[:, :3].astype(float)[~drop]
            if len(xyz) < 3:
                continue
            sm = np.stack([smooth(xyz[:, k], 5) for k in range(3)], 1)
            out[p.arm] += float(np.linalg.norm(np.diff(sm, axis=0), axis=1).sum())  # type: ignore[index]
    return out


def resolve_active_arms(
    ds: LeRobotDataset, spec: CriticSpec, n_episodes: int = 5, ratio: float = 5.0
) -> tuple[list[str], dict[str, str]]:
    """The arms the critics score, checked against the data, and what was found.

    Unset on a robot with two or more arms: the arm that moves at least ``ratio`` times as
    much as the quietest one is the active one (``ACTIVE_ARMS_UNSET``). Set and an inactive
    arm moves clearly more than the named ones: kept, but ``ACTIVE_ARMS_SUSPECT``. Set to a
    name no feature carries: all arms are scored (``ACTIVE_ARMS_UNKNOWN``).
    """
    named = [a.lower() for a in spec.robot.active_arms]
    rf = detect_features(ds, spec)
    known = _arm_names(rf)
    if named:
        missing = [a for a in named if a not in known]
        if missing:
            return [], {
                "ACTIVE_ARMS_UNKNOWN": (
                    f"robot.active_arms names {', '.join(missing)}, but the features only carry "
                    f"{', '.join(sorted(known)) or 'no left or right arm'}: all arms are scored"
                )
            }
    motion = arm_motion(ds, spec, n_episodes)
    if not named:
        if len(motion) < 2:
            return [], {}
        top = max(motion, key=lambda a: motion[a])
        low = min(motion.values())
        if motion[top] > 0 and motion[top] >= ratio * low:
            return [top], {
                "ACTIVE_ARMS_UNSET": (
                    f"robot.active_arms is not set: the {top} arm moves {_times(motion[top], low)} as much "
                    f"as the other, so only it is scored"
                )
            }
        return [], {}
    active_max = max((motion.get(a, 0.0) for a in named), default=0.0)
    idle = {a: m for a, m in motion.items() if a not in named}
    worst = max(idle, key=lambda a: idle[a], default=None)
    if worst is not None and idle[worst] > ratio * active_max and idle[worst] > 0:
        return named, {
            "ACTIVE_ARMS_SUSPECT": (
                f"robot.active_arms is {', '.join(named)}, but the {worst} arm moves "
                f"{_times(idle[worst], active_max)} as much: is the spec naming the right arm?"
            )
        }
    return named, {}


def _times(a: float, b: float) -> str:
    return f"{a / b:.0f} times" if b > 1e-9 else "far more than"
