"""Shortcuts a policy can learn instead of the task, measured over a set of episodes.

A policy is trained to map what it sees and its own state to an action. When something
other than the instruction already tells which object to take, the policy may learn that
instead of reading the prompt or looking at the object:

- **background**: the first camera image tells the prompt (or the acting arm) even for a
  scene the policy has never seen, because every prompt was recorded in front of its own
  set-up (a session per product, a different light, a different shelf filling);
- **start cue**: the robot's own state in the first frame tells the acting arm or the
  prompt (an operator who parks the idle hand lower, a start pose per side);
- **few counterfactuals**: every scene was recorded with one prompt only, so the prompt
  never has to decide between two objects that are both in view;
- **layout**: every target always sat in the same place, so "where" answers "what".

Every figure here is a held-out-scene test: the episodes of a scene are held out together
(scenes dealt into at most ten folds) and predicted from all the others, by a
k-nearest-neighbour vote (pictures, positions) or a regularised logistic regression (robot
state, where one telling joint among dozens must not drown). Accuracy near
chance (the share of the most frequent class) means the signal carries nothing; accuracy
far above it means a shortcut is there to be learned. Scenes are groups of consecutive
episodes of one dataset whose first frames are practically the same picture.

The same per-episode features also drive the prompt check (:func:`align_prompts`): the
object an episode actually picked is read from its appearance (the pixels that changed
between the first and the last frame of the scene camera, and the middle of the wrist
camera's last frame), compared with what the episodes of every prompt look like, and a
prompt that does not fit is proposed for a change or raised for review, never changed.

Everything is numpy, deterministic and keeps nothing: the service is handed the features
of one selection and answers with the figures.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

import numpy as np

THUMB_W, THUMB_H = 24, 18
# a pixel counts as changed between the first and the last frame above this max-channel difference
CHANGE_LEVEL = 45
# saturated pixels carry the hue of an object; a shelf, a table or an arm is mostly grey
SATURATED = 60

DEFAULTS: dict[str, Any] = {
    "k": 5,
    # lift = (accuracy - chance) / (1 - chance); a cue flag needs both
    "cue_lift": 0.5,
    "cue_accuracy": 0.75,
    # a fold needs this many episodes and two scenes before a figure is given at all
    "min_episodes": 8,
    # scenes: None = found from the gaps between consecutive first frames
    "scene_threshold": None,
    "scene_absolute": 0.1,
    # layout grid of the grasp positions
    "layout_cell_cm": 8.0,
    # share of episodes that need a same-scene partner with another prompt
    "counterfactual_share": 0.5,
    # an evaluation start this many times the typical gap between training starts away is out of range
    "eval_range_ratio": 2.0,
    "eval_in_range_share": 0.8,
    "eval_one_arm_share": 0.8,
}

FLAG_DOCS = {
    "BACKGROUND_CUE": "the first camera image tells the prompt or the acting arm for scenes the policy never saw",
    "START_CUE": "the robot state in the first frame tells the acting arm or the prompt",
    "FEW_COUNTERFACTUALS": "most scenes were recorded with one prompt only",
    "POSITION_CUE": "the grasp position tells the prompt: every target sat in its own place",
    "EVAL_START_OUT_OF_RANGE": "the evaluation started from poses the recordings never started from",
    "EVAL_START_CUE": "the evaluation start pose points the policy at one arm",
}


# --------------------------------------------------------------------------- features
def thumbnail(img: np.ndarray) -> list[int]:
    """The image reduced to THUMB_W x THUMB_H RGB, as a flat list of 0..255 integers."""
    import cv2

    small = cv2.resize(img[..., :3], (THUMB_W, THUMB_H), interpolation=cv2.INTER_AREA)
    return [int(v) for v in small.reshape(-1)]


def colour_signature(pixels: np.ndarray) -> list[float]:
    """A colour signature of a set of RGB pixels: 12 hue bins weighted by saturation (over the
    saturated pixels only), 6 brightness bins (all pixels) and the saturated share. 19 numbers."""
    import cv2

    px = np.asarray(pixels, np.uint8).reshape(-1, 1, 3)
    if len(px) == 0:
        return [0.0] * 19
    hsv = cv2.cvtColor(px, cv2.COLOR_RGB2HSV).reshape(-1, 3).astype(np.float64)
    sat = hsv[:, 1] > SATURATED
    hue = np.histogram(hsv[sat, 0], bins=12, range=(0, 180), weights=hsv[sat, 1])[0]
    hue = hue / (hue.sum() + 1e-9)
    val = np.histogram(hsv[:, 2], bins=6, range=(0, 256))[0] / len(hsv)
    return [round(float(v), 4) for v in np.concatenate([hue, val, [sat.mean()]])]


def changed_signature(first: np.ndarray | None, last: np.ndarray | None) -> list[float] | None:
    """The colours, in the first frame, of the pixels that changed by the last frame: where the
    object was taken from (and, mixed in, what the arm covers at the end). None when (almost)
    nothing changed or a frame is missing."""
    if first is None or last is None or first.shape != last.shape:
        return None
    a = first.astype(np.int16)
    diff = np.abs(a - last.astype(np.int16)).max(axis=2)
    mask = diff > CHANGE_LEVEL
    if mask.mean() < 0.002:
        return None
    return colour_signature(first[mask])


def centre_signature(img: np.ndarray | None) -> list[float] | None:
    """The colours of the middle half of an image: on a wrist camera at the end of a pick, the
    object in the hand."""
    if img is None:
        return None
    h, w = img.shape[:2]
    return colour_signature(img[h // 4 : h - h // 4, w // 4 : w - w // 4].reshape(-1, 3))


# --------------------------------------------------------------------------- episodes
@dataclass
class Episode:
    """The features of one episode that the analyses read, from a diversity critic's metrics."""

    key: str
    dataset: str
    order: int
    prompt: str | None
    arm: str | None
    start: np.ndarray | None
    end: np.ndarray | None
    thumb: np.ndarray | None
    grasp: np.ndarray | None
    look: np.ndarray | None


def _vec(v: Any) -> np.ndarray | None:
    if not isinstance(v, list) or not v:
        return None
    try:
        a = np.asarray(v, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    return a if np.all(np.isfinite(a)) else None


def episode_from(
    metrics: dict[str, Any] | None,
    key: str,
    dataset: str = "",
    order: int = 0,
    prompt: str | None = None,
) -> Episode:
    """One episode from the metrics of its ``diversity`` result (any age: what is missing is None).

    ``prompt`` wins over the prompt the critic recorded: the owner of the data may have
    corrected it since.
    """
    m = metrics or {}
    cf = m.get("cue_features") if isinstance(m.get("cue_features"), dict) else {}
    arm = m.get("grasp_arm") or None
    grasp = None
    by_arm = m.get("grasps_by_arm") or {}
    if arm and isinstance(by_arm.get(arm), dict):
        grasp = _vec((by_arm[arm].get("grasp_pos_m") or [None])[0])
    if grasp is None:
        grasp = _vec((m.get("grasp_pos_m") or [None])[0])
    thumb = cf.get("thumb") if isinstance(cf.get("thumb"), dict) else {}
    t = _vec(thumb.get("rgb"))
    return Episode(
        key=str(key),
        dataset=str(dataset),
        order=int(order),
        prompt=prompt if prompt is not None else (cf.get("prompt") or None),
        arm=arm,
        start=_vec(cf.get("start_state")),
        end=_vec(cf.get("end_state")),
        thumb=t / 255.0 if t is not None else None,
        grasp=grasp,
        look=_vec(cf.get("look")),
    )


# --------------------------------------------------------------------------- scenes
def _otsu(values: np.ndarray) -> float | None:
    """The cut between the two groups of ``values`` (log scale) when they are clearly two."""
    v = np.sort(np.log(values + 1e-4))
    if len(v) < 3:
        return None
    best, cut = -1.0, None
    for i in range(1, len(v)):
        lo, hi = v[:i], v[i:]
        between = len(lo) * len(hi) * (lo.mean() - hi.mean()) ** 2
        if between > best:
            best, cut = between, i
    lo, hi = np.exp(v[:cut]), np.exp(v[cut:])
    if np.median(hi) < 3 * max(np.median(lo), 1e-3):
        return None
    return float((lo.max() + hi.min()) / 2)


def thumb_distance(a: np.ndarray, b: np.ndarray) -> float:
    """How different two first frames are: the 98th percentile of the per-pixel colour change
    (0..1). A moved product changes a few pixels a lot, noise and a slightly other start pose of
    the arm change many a little. On a shelf of five products (24 x 18 picture) the same scene
    stays below ~0.05 and a new layout lies above ~0.13."""
    d = np.abs(a.reshape(-1, 3) - b.reshape(-1, 3)).max(axis=1)
    return float(np.percentile(d, 98))


def find_scenes(eps: list[Episode], threshold: float | None = None, absolute: float = 0.1) -> dict:
    """Group consecutive episodes of a dataset with practically the same first frame.

    Returns ``{"labels": [scene per episode], "threshold": t, "method": ...}``. Episodes without
    a first frame are a scene of their own.
    """
    by_ds: dict[str, list[int]] = defaultdict(list)
    for i, e in enumerate(eps):
        by_ds[e.dataset].append(i)
    gaps: list[tuple[int, int, float]] = []
    for idx in by_ds.values():
        idx.sort(key=lambda i: eps[i].order)
        for a, b in zip(idx[:-1], idx[1:], strict=False):
            if (
                eps[a].thumb is not None
                and eps[b].thumb is not None
                and eps[a].thumb.shape == eps[b].thumb.shape
            ):
                gaps.append((a, b, thumb_distance(eps[a].thumb, eps[b].thumb)))
    method = "fixed"
    t = threshold
    if t is None:
        t = _otsu(np.array([g for _, _, g in gaps])) if gaps else None
        method = "auto"
        if t is None:
            t = absolute
            method = "absolute"
    same = {(a, b) for a, b, g in gaps if g <= t}
    labels: list[str] = [""] * len(eps)
    for ds, idx in by_ds.items():
        n = 0
        for j, i in enumerate(idx):
            if j and (idx[j - 1], i) in same:
                labels[i] = labels[idx[j - 1]]
            else:
                n += 1
                labels[i] = f"{ds}#{n}"
    return {"labels": labels, "threshold": round(float(t), 4), "method": method}


# --------------------------------------------------------------------------- classifier
def pairwise(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Euclidean distances between the rows of ``a`` and ``b``, without an (n, m, d) array."""
    sq = (a**2).sum(1)[:, None] + (b**2).sum(1)[None, :] - 2.0 * (a @ b.T)
    return np.sqrt(np.maximum(sq, 0.0))


def _standardise(x: np.ndarray, ref: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ref = x if ref is None else ref
    mu = ref.mean(0)
    sd = ref.std(0)
    keep = sd > 1e-9
    sd = np.where(keep, sd, 1.0)
    return ((x - mu) / sd)[:, keep], mu, sd


def _vote(labels: list[str], dists: np.ndarray) -> tuple[str, float]:
    """Majority of the neighbours, ties to the nearer; the winner's share of the votes."""
    c = Counter(labels)
    top = max(c.values())
    winners = [lab for lab in labels if c[lab] == top]
    return winners[0], top / len(labels)


MAX_FOLDS = 10


def _folds(groups: list[str], n_folds: int = MAX_FOLDS) -> np.ndarray:
    """A fold per episode: whole groups (scenes) go to one fold, at most ``n_folds`` folds."""
    order = {g: i % n_folds for i, g in enumerate(dict.fromkeys(groups))}
    return np.array([order[g] for g in groups])


def _softmax_fit(
    x: np.ndarray, y: np.ndarray, classes: int, lam: float = 1.0, iters: int = 300
) -> np.ndarray:
    """Multinomial logistic regression with an L2 penalty, by gradient descent (x standardised)."""
    n, d = x.shape
    xb = np.hstack([np.ones((n, 1)), x])
    onehot = np.eye(classes)[y]
    w = np.zeros((d + 1, classes))
    lr = 1.0
    for _ in range(iters):
        logits = xb @ w
        logits -= logits.max(1, keepdims=True)
        prob = np.exp(logits)
        prob /= prob.sum(1, keepdims=True)
        grad = xb.T @ (prob - onehot) / n
        grad[1:] += lam * w[1:] / n
        w -= lr * grad
    return w


def _predict_knn(z: np.ndarray, ya: np.ndarray, train: np.ndarray, test: np.ndarray, k: int) -> list:
    d = pairwise(z[test], z[train])
    out = []
    for row in d:
        near = np.argsort(row)[:k]
        out.append(_vote(list(ya[train][near]), row[near])[0])
    return out


def _predict_logistic(z: np.ndarray, ya: np.ndarray, train: np.ndarray, test: np.ndarray) -> list:
    labels = sorted(set(ya[train]))
    if len(labels) == 1:
        return [labels[0]] * len(test)
    code = {lab: i for i, lab in enumerate(labels)}
    xt = z[train]
    mu, sd = xt.mean(0), xt.std(0)
    sd = np.where(sd > 1e-9, sd, 1.0)
    w = _softmax_fit((xt - mu) / sd, np.array([code[v] for v in ya[train]]), len(labels))
    xs = (z[test] - mu) / sd
    pred = (np.hstack([np.ones((len(xs), 1)), xs]) @ w).argmax(1)
    return [labels[i] for i in pred]


def group_cv(
    x: np.ndarray,
    y: list[str],
    groups: list[str],
    k: int = 5,
    min_n: int = 8,
    method: str = "knn",
) -> dict | None:
    """Accuracy of predicting ``y`` from ``x`` for episodes whose whole scene was held out.

    The scenes are dealt into at most ten folds; each fold is predicted from the others, by a
    k-nearest-neighbour vote (``knn``: pictures, positions) or a regularised logistic regression
    (``logistic``: a robot state, where one telling dimension among many must not drown).
    None when there is nothing to test: fewer than ``min_n`` episodes, one class, or one group.
    ``chance`` is the share of the most frequent class; ``lift`` how far above it the accuracy is
    on a 0..1 scale (0 = no better than always answering the majority, 1 = always right).
    """
    if len(y) < min_n or len(set(y)) < 2 or len(set(groups)) < 2:
        return None
    z = x.reshape(len(x), -1).astype(np.float64)
    ya = np.asarray(y, dtype=object)
    folds = _folds(groups)
    hits: list[bool] = []
    for f in np.unique(folds):
        test = np.where(folds == f)[0]
        train = np.where(folds != f)[0]
        if not len(train):
            continue
        if method == "logistic":
            pred = _predict_logistic(z, ya, train, test)
        else:
            pred = _predict_knn(z, ya, train, test, k)
        hits += [p_ == t for p_, t in zip(pred, ya[test], strict=True)]
    if not hits:
        return None
    acc = float(np.mean(hits))
    chance = max(Counter(y).values()) / len(y)
    lift = (acc - chance) / (1 - chance) if chance < 1 else 0.0
    return {
        "accuracy": round(acc, 3),
        "chance": round(chance, 3),
        "lift": round(max(lift, 0.0), 3),
        "n": len(hits),
        "classes": len(set(y)),
        "scenes": len(set(groups)),
        "method": method,
    }


def _cue(cv: dict | None, p: dict) -> bool:
    return bool(cv and cv["lift"] >= p["cue_lift"] and cv["accuracy"] >= p["cue_accuracy"])


def _subset(eps: list[Episode], attr: str, label: str) -> tuple[np.ndarray, list[str], list[int]] | None:
    """The episodes that have both the feature ``attr`` (all of one length) and the label."""
    idx = [i for i, e in enumerate(eps) if getattr(e, attr) is not None and getattr(e, label)]
    if not idx:
        return None
    dims = Counter(len(getattr(eps[i], attr)) for i in idx).most_common(1)[0][0]
    idx = [i for i in idx if len(getattr(eps[i], attr)) == dims]
    return np.stack([getattr(eps[i], attr) for i in idx]), [getattr(eps[i], label) for i in idx], idx


def _cv(eps, scenes, attr, label, p, method="knn"):
    s = _subset(eps, attr, label)
    if s is None:
        return None
    x, y, idx = s
    return group_cv(x, y, [scenes[i] for i in idx], int(p["k"]), int(p["min_episodes"]), method)


# --------------------------------------------------------------------------- analyses
def _counterfactual(eps: list[Episode], scenes: list[str]) -> dict | None:
    prompts = {e.prompt for e in eps if e.prompt}
    if len(prompts) < 2:
        return None
    by_scene: dict[str, list[int]] = defaultdict(list)
    for i, e in enumerate(eps):
        if e.prompt:
            by_scene[scenes[i]].append(i)
    per_scene = {s: {eps[i].prompt for i in idx} for s, idx in by_scene.items()}
    multi = [s for s, ps in per_scene.items() if len(ps) > 1]
    n = sum(len(v) for v in by_scene.values())
    partner = sum(
        1 for s, idx in by_scene.items() for i in idx if any(eps[j].prompt != eps[i].prompt for j in idx)
    )
    # in a scene with several prompts: does the acting arm already settle which one?
    arm_known = [(s, i) for s in multi for i in by_scene[s] if eps[i].arm]
    answered = [
        len({eps[j].prompt for j in by_scene[s] if eps[j].arm == eps[i].arm}) == 1 for s, i in arm_known
    ]
    return {
        "scenes": len(by_scene),
        "scenes_multi_prompt": round(len(multi) / len(by_scene), 3),
        "episodes_with_partner": round(partner / n, 3) if n else 0.0,
        "prompts_per_scene": dict(sorted(Counter(str(len(v)) for v in per_scene.values()).items())),
        "answered_by_arm": round(float(np.mean(answered)), 3) if answered else None,
    }


def _layout(eps: list[Episode], scenes: list[str], p: dict) -> dict | None:
    idx = [i for i, e in enumerate(eps) if e.grasp is not None and e.prompt]
    if len(idx) < 2:
        return None
    cell = float(p["layout_cell_cm"]) / 100.0
    xy = np.stack([eps[i].grasp[:2] for i in idx])
    cells = [tuple(int(v) for v in np.floor(c / cell)) for c in xy]
    held: dict[tuple, set] = defaultdict(set)
    for c, i in zip(cells, idx, strict=False):
        held[c].add(eps[i].prompt)
    shared = {c for c, ps in held.items() if len(ps) > 1}
    per_prompt: dict[str, dict] = {}
    for prompt in sorted({eps[i].prompt for i in idx}):
        mine = [j for j, i in enumerate(idx) if eps[i].prompt == prompt]
        pts = xy[mine]
        per_prompt[prompt] = {
            "n": len(mine),
            "cells": len({cells[j] for j in mine}),
            "std_cm": [round(float(v), 1) for v in pts.std(0) * 100],
        }
    return {
        "cell_cm": float(p["layout_cell_cm"]),
        "cells": len(held),
        "cells_multi_prompt": round(len(shared) / len(held), 3),
        "episodes_in_shared_cells": round(sum(c in shared for c in cells) / len(cells), 3),
        "per_prompt": per_prompt,
        "position_cue": group_cv(
            xy, [eps[i].prompt for i in idx], [scenes[i] for i in idx], int(p["k"]), int(p["min_episodes"])
        ),
    }


def _evaluation(train: list[Episode], evaluation: list[Episode], p: dict) -> dict | None:
    s = _subset(train, "start", "key")
    ev = [e for e in evaluation if e.start is not None]
    if s is None or not ev:
        return None
    x, _, idx = s
    dims = x.shape[1]
    ev = [e for e in ev if len(e.start) == dims]
    if not ev or len(idx) < 2:
        return None
    zt, mu, sd = _standardise(x)
    keep = x.std(0) > 1e-9
    ze = ((np.stack([e.start for e in ev]) - mu) / sd)[:, keep]
    dt = pairwise(zt, zt)
    np.fill_diagonal(dt, np.inf)
    typical = float(np.median(dt.min(1))) or 1e-9
    de = pairwise(ze, zt)
    ratio = de.min(1) / typical
    arms = [train[i].arm for i in idx]
    k = int(p["k"])
    predicted: list[str] = []
    conf: list[float] = []
    if len({a for a in arms if a}) > 1:
        for row in de:
            near = [j for j in np.argsort(row) if arms[j]][:k]
            pred, share = _vote([arms[j] for j in near], row[near])
            predicted.append(pred)
            conf.append(share)
    out = {
        "n": len(ev),
        "in_range": round(float(np.mean(ratio <= p["eval_range_ratio"])), 3),
        "distance_ratio_median": round(float(np.median(ratio)), 2),
        "predicted_arm": dict(Counter(predicted)) if predicted else None,
        "arm_confidence": round(float(np.mean(conf)), 3) if conf else None,
    }
    return out


def analyse(
    episodes: list[Episode],
    evaluation: list[Episode] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Every shortcut figure over ``episodes``, the evaluation starts against them, and flags."""
    p = {**DEFAULTS, **(params or {})}
    eps = list(episodes)
    sc = find_scenes(eps, p["scene_threshold"], float(p["scene_absolute"]))
    scenes = sc["labels"]
    sizes = Counter(Counter(scenes).values())
    out: dict[str, Any] = {
        "n": len(eps),
        "prompts": dict(Counter(e.prompt for e in eps if e.prompt)),
        "arms": dict(Counter(e.arm for e in eps if e.arm)),
        "scenes": {
            "n": len(set(scenes)),
            "threshold": sc["threshold"],
            "method": sc["method"],
            "episodes_per_scene": {str(k): v for k, v in sorted(sizes.items())},
        },
        "background": {
            "prompt": _cv(eps, scenes, "thumb", "prompt", p),
            "arm": _cv(eps, scenes, "thumb", "arm", p),
        },
        "start_cue": {
            "arm": _cv(eps, scenes, "start", "arm", p, "logistic"),
            "prompt": _cv(eps, scenes, "start", "prompt", p, "logistic"),
        },
        "end_cue": {"prompt": _cv(eps, scenes, "end", "prompt", p, "logistic")},
        "counterfactual": _counterfactual(eps, scenes),
        "layout": _layout(eps, scenes, p),
        "evaluation": _evaluation(eps, evaluation or [], p),
    }
    flags: dict[str, str] = {}
    bg = out["background"]
    for what in ("prompt", "arm"):
        if _cue(bg[what], p):
            cv = bg[what]
            flags["BACKGROUND_CUE"] = (
                f"The first camera image tells the {what} of a scene it never saw in {cv['accuracy']:.0%} of "
                f"{cv['n']} episodes (chance {cv['chance']:.0%}). Every {what} was recorded in front of its own "
                "set-up; record each set-up with several prompts and arms."
            )
            break
    st = out["start_cue"]
    for what in ("arm", "prompt"):
        if _cue(st[what], p):
            cv = st[what]
            flags["START_CUE"] = (
                f"The robot state in the first frame tells the {what} in {cv['accuracy']:.0%} of {cv['n']} episodes "
                f"(chance {cv['chance']:.0%}, scenes held out). The policy can choose before it looks; start every "
                "episode from the same pose, whatever the prompt."
            )
            break
    cf = out["counterfactual"]
    if cf and cf["episodes_with_partner"] < p["counterfactual_share"]:
        flags["FEW_COUNTERFACTUALS"] = (
            f"Only {cf['episodes_with_partner']:.0%} of the episodes share their scene with another prompt. The "
            "prompt rarely has to choose between objects that are both in view; record several prompts per scene."
        )
    lay = out["layout"]
    if lay and _cue(lay["position_cue"], p):
        cv = lay["position_cue"]
        flags["POSITION_CUE"] = (
            f"The grasp position tells the prompt in {cv['accuracy']:.0%} of {cv['n']} episodes (chance "
            f"{cv['chance']:.0%}); only {lay['cells_multi_prompt']:.0%} of the {lay['cell_cm']:g} cm cells ever held "
            "more than one target. Swap the places of the objects between scenes."
        )
    ev = out["evaluation"]
    if ev:
        if ev["in_range"] < p["eval_in_range_share"]:
            flags["EVAL_START_OUT_OF_RANGE"] = (
                f"Only {ev['in_range']:.0%} of {ev['n']} evaluation starts lie among the recorded starts (median "
                f"distance {ev['distance_ratio_median']:g} times the usual gap). The policy starts from a pose it "
                "never saw."
            )
        pa = ev.get("predicted_arm") or {}
        if pa and _cue(st["arm"], p) and max(pa.values()) / sum(pa.values()) >= p["eval_one_arm_share"]:
            arm = max(pa, key=pa.get)
            flags["EVAL_START_CUE"] = (
                f"The evaluation start pose looks like a '{arm}' start in {max(pa.values())} of {sum(pa.values())} "
                "rollouts, and the start pose tells the arm in the recordings: the policy is pointed at one arm "
                "before it reads the prompt."
            )
    out["flags"] = flags
    return out


# --------------------------------------------------------------------------- prompts
def _kmeans(x: np.ndarray, k: int, restarts: int = 12) -> np.ndarray:
    """k-means++ with several seeds; the grouping with the smallest spread wins. Deterministic."""
    best, best_cost = None, np.inf
    for seed in range(restarts):
        lab, cost = _kmeans_once(x, k, seed)
        if cost < best_cost:
            best, best_cost = lab, cost
    return best


def _kmeans_once(x: np.ndarray, k: int, seed: int, iters: int = 50) -> tuple[np.ndarray, float]:
    rng = np.random.default_rng(seed)
    centres = [x[rng.integers(len(x))]]
    for _ in range(1, k):
        d = np.min([((x - c) ** 2).sum(1) for c in centres], axis=0)
        if d.sum() <= 0:
            break
        centres.append(x[rng.choice(len(x), p=d / d.sum())])
    c = np.stack(centres)
    lab = np.zeros(len(x), int)
    for _ in range(iters):
        lab = pairwise(x, c).argmin(1)
        new = np.stack([x[lab == j].mean(0) if np.any(lab == j) else c[j] for j in range(len(c))])
        if np.allclose(new, c):
            break
        c = new
    return lab, float(((x - c[lab]) ** 2).sum())


def align_prompts(
    targets: list[Episode],
    reference: list[Episode],
    candidates: list[str] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Does every target episode's prompt fit what it picked?

    The reference episodes (normally the other datasets of the skill, with their prompts as
    they stand now) say what the object of each prompt looks like. Each target is placed among
    them by its appearance (k nearest, distance-weighted) and gets a status:

    - ``ok``: its own prompt wins;
    - ``propose``: another prompt wins clearly and its own has (almost) no vote; ``proposed``
      names it;
    - ``review``: no clear winner (two prompts look alike, or too few examples);
    - ``no_signature``: the episode has no appearance to compare.

    With fewer than two prompts among the references (a dataset recorded under one stand-in
    prompt, and nothing else to learn from), the targets are grouped by appearance instead
    (``mode: "groups"``): every target gets a ``group`` and status ``review``, so a person can
    name each group once.
    """
    p = {"k": 7, "ok_share": 0.5, "propose_share": 0.7, "own_share_max": 0.15, "min_examples": 3}
    p.update(params or {})
    target_keys = {t.key for t in targets}
    ref = [e for e in reference if e.look is not None and e.prompt and e.key not in target_keys]
    if len({e.prompt for e in ref}) < 2:
        # nothing outside the targets to learn from: the targets teach each other
        ref = ref + [t for t in targets if t.look is not None and t.prompt]
    with_look = [t for t in targets if t.look is not None]
    prompts = Counter(e.prompt for e in ref)
    out: dict[str, Any] = {
        "prompts": dict(prompts),
        "candidates": sorted(set(candidates or []) | set(prompts)),
    }
    dims = Counter(len(e.look) for e in ref + with_look).most_common(1)[0][0] if ref or with_look else 0
    ref = [e for e in ref if len(e.look) == dims]
    if len(prompts) < 2:
        # as many groups as the task has prompts; the stand-in prompt of the targets is not one of them
        k = max(2, min(len(set(candidates or [])) or 2, len(with_look)))
        usable = [t for t in with_look if len(t.look) == dims]
        groups: dict[str, int] = {}
        if len(usable) >= 2:
            z, _, _ = _standardise(np.stack([t.look for t in usable]))
            lab = _kmeans(z, min(k, len(usable)))
            groups = {t.key: int(g) + 1 for t, g in zip(usable, lab, strict=False)}
        out["mode"] = "groups"
        out["episodes"] = [
            {
                "id": t.key,
                "prompt": t.prompt,
                "status": "review" if t.key in groups else "no_signature",
                "group": groups.get(t.key),
            }
            for t in targets
        ]
        return out
    all_x = np.stack([e.look for e in ref])
    _, mu, sd = _standardise(all_x)
    keep = all_x.std(0) > 1e-9

    def z(v: np.ndarray) -> np.ndarray:
        return ((v - mu) / sd)[..., keep]

    zr = z(all_x)
    labels = [e.prompt for e in ref]
    keys = [e.key for e in ref]

    def place(v: np.ndarray, skip: str | None) -> dict[str, float]:
        d = np.sqrt(((zr - z(v)) ** 2).sum(1))
        order = [j for j in np.argsort(d) if keys[j] != skip][: int(p["k"])]
        w = 1.0 / (d[order] + 1e-3)
        votes: dict[str, float] = defaultdict(float)
        for j, wj in zip(order, w, strict=False):
            votes[labels[j]] += float(wj)
        total = sum(votes.values()) or 1.0
        return {k: v / total for k, v in sorted(votes.items(), key=lambda kv: -kv[1])}

    # how often does the reference itself mistake one prompt for another (leave one out)
    confusion: Counter = Counter()
    for e in ref:
        best = next(iter(place(e.look, e.key)))
        if best != e.prompt:
            confusion[tuple(sorted((e.prompt, best)))] += 1
    out["confusable"] = [
        {"prompts": list(pair), "rate": round(n / (prompts[pair[0]] + prompts[pair[1]]), 3)}
        for pair, n in confusion.most_common()
        if n / (prompts[pair[0]] + prompts[pair[1]]) >= 0.1
    ]
    out["mode"] = "reference"
    rows = []
    for t in targets:
        if t.look is None or len(t.look) != dims:
            rows.append({"id": t.key, "prompt": t.prompt, "status": "no_signature"})
            continue
        votes = place(t.look, t.key)
        best, share = next(iter(votes.items()))
        own = votes.get(t.prompt or "", 0.0)
        row: dict[str, Any] = {
            "id": t.key,
            "prompt": t.prompt,
            "votes": {k: round(v, 3) for k, v in votes.items()},
            "confidence": round(share, 3),
        }
        # a pair the references themselves mix up is never settled by the appearance alone
        alike = {p_ for c in out["confusable"] if best in c["prompts"] for p_ in c["prompts"]} - {best}
        own_alike = (t.prompt or "") in alike
        if best == t.prompt and share >= p["ok_share"] and not (alike and share < p["propose_share"]):
            row["status"] = "ok"
        elif (
            best != t.prompt
            and not own_alike
            and share >= p["propose_share"]
            and own <= p["own_share_max"]
            and prompts[best] >= p["min_examples"]
        ):
            row["status"] = "propose"
            row["proposed"] = best
        else:
            row["status"] = "review"
            row["proposed"] = best if best != t.prompt else None
            row["reason"] = (
                "few_examples"
                if prompts[best] < p["min_examples"]
                else ("look_alike" if alike or own_alike else "uncertain")
            )
        rows.append(row)
    out["episodes"] = rows
    out["counts"] = dict(Counter(r["status"] for r in rows))
    return out
