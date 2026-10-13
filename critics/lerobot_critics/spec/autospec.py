"""Generate a starter spec from a dataset (task text, robot type, arms, cameras)."""

from __future__ import annotations

from pathlib import Path

from ..dataset.loader import open_dataset
from .models import CriticSpec, Purpose, RobotSpec, TaskSpec


def auto_spec(
    dataset: str | Path, active_arms: list[str] | None = None, purpose: Purpose = "recording"
) -> CriticSpec:
    ds = open_dataset(dataset)
    task = next(iter(ds.tasks.values()), "") or (ds.task_for(ds.episode_indices()[0]) if ds.episodes else "")
    # A dataset with several tasks has no single instruction to pin: task.per_episode (default) makes
    # every episode be judged against its own recorded task, and this one stays as the fallback only.
    notes = ""
    if len(ds.tasks) > 1:
        notes = (
            f"This dataset records {len(ds.tasks)} distinct task instructions; each episode is judged "
            "against its own (task.per_episode). Keep the success indicators worded relative to the "
            "instruction rather than naming one concrete object."
        )
    arms = active_arms
    if arms is None:
        # guess the active arm: the one whose action moves most in the first episode
        try:
            ep = ds.episode(ds.episode_indices()[0])
            import numpy as np

            best, best_v = None, -1.0
            for k in ds.numeric_keys:
                if not k.startswith("action"):
                    continue
                arm = "left" if "left" in k.lower() else ("right" if "right" in k.lower() else None)
                if arm is None:
                    continue
                v = float(np.linalg.norm(np.diff(ep.array(k)[:, :3], axis=0), axis=1).sum())
                if v > best_v:
                    best, best_v = arm, v
            arms = [best] if best else []
        except Exception:  # noqa: BLE001
            arms = []
    spec = CriticSpec(
        name=ds.root.name,
        purpose=purpose,
        task=TaskSpec(instruction=task or "unknown task", notes=notes),
        robot=RobotSpec(type=ds.robot_type, active_arms=arms or []),
    )
    # repetitions per episode: median number of carried grasp cycles over the first episodes, so a
    # 5-repetition protocol is not flagged MULTIGRASP on every episode
    try:
        spec.task.expected_cycles = _guess_cycles(ds, spec)
    except Exception:  # noqa: BLE001 - a guess, never a failure
        spec.task.expected_cycles = None
    return spec


def _guess_cycles(ds, spec: CriticSpec, max_episodes: int = 5) -> int | None:
    import numpy as np

    from ..critics.hard.grasp_cycles import closure_signal, detect_cycles
    from ..dataset.features import detect_features

    counts = []
    for idx in ds.episode_indices()[:max_episodes]:
        ep = ds.episode(idx)
        rf = detect_features(ds, spec, ep)
        g = rf.gripper
        if g is None or not ep.has(g.feature):
            return None
        sig = closure_signal(ep, g.feature, g.dims, g.closed_is_high)
        counts.append(detect_cycles(sig, ep.fps)["n_cycles"])
    if not counts:
        return None
    n = int(round(float(np.median(counts))))
    return n if n >= 1 else None
