"""Default hard critics (with weights + thresholds), default success indicators and default
scoring, per purpose of the spec.

A **recording** is judged as training data: every technical check weighs on the score, a
frozen command or a follower that does not follow rejects the episode, and anything a person
should watch before training on it caps the verdict at review.

An **evaluation** is judged on the outcome of the task: the policy either did it or not. The
technical checks still run and still raise their flags (a stalled camera is a fact of the
rollout), but none of them weighs on the score or gates the verdict; only a broken file
does, because a broken file is no rollout. Checks that only describe a human operator
(input-device tremor, the spatial diversity of the demonstrations) are off. The success
indicators are the placement (decisive), the object and the disturbances before the task
was done; a major anomaly after a correct placement does not undo the success.
"""

from __future__ import annotations

from typing import Any

from .models import HardCriticConfig, Purpose, SoftIndicator, TaskSpec


def default_hard_critics(purpose: Purpose = "recording") -> list[HardCriticConfig]:
    if purpose == "evaluation":
        return [
            HardCriticConfig(
                id="integrity",
                weight=0.0,
                gate=True,
                gate_below=0.5,
                gate_flags=["VIDEO_MISSING", "NAN_VALUES", "LENGTH_MISMATCH", "EMPTY"],
            ),
            HardCriticConfig(id="duration", weight=0.0),
            HardCriticConfig(id="smoothness", weight=0.0),
            HardCriticConfig(id="tracking_error", weight=0.0),
            HardCriticConfig(id="duplication", weight=0.0),
            HardCriticConfig(id="image_quality", weight=0.0),
            HardCriticConfig(id="sensor_limits", weight=0.0),
            # keyframes for the report and the frame sampling; a policy that never grasps fails the
            # placement indicator, so there is no NOGRASP gate
            HardCriticConfig(id="grasp_cycles", weight=0.0),
            HardCriticConfig(id="tremor", weight=0.0, enabled=False),
            HardCriticConfig(id="normalization", weight=0.0),
            HardCriticConfig(id="diversity", weight=0.0, enabled=False),
        ]
    return [
        HardCriticConfig(
            id="integrity",
            weight=1.0,
            gate=True,
            gate_below=0.5,
            gate_flags=["VIDEO_MISSING", "NAN_VALUES", "LENGTH_MISMATCH", "EMPTY"],
        ),
        HardCriticConfig(id="duration", weight=1.0, gate_flags=["TOO_SHORT", "TOO_LONG"]),
        HardCriticConfig(id="smoothness", weight=1.0),
        HardCriticConfig(id="tracking_error", weight=1.5, gate=True, gate_below=0.1, gate_flags=["TRACKERR"]),
        HardCriticConfig(
            id="duplication", weight=1.0, gate=True, gate_below=0.1, gate_flags=["LAGGY", "CAMSTALL"]
        ),
        HardCriticConfig(id="image_quality", weight=1.0),
        HardCriticConfig(id="sensor_limits", weight=1.0),
        HardCriticConfig(id="grasp_cycles", weight=1.0, gate_flags=["NOGRASP"]),
        # teleop input tremor / hold jitter (the policy learns the command, shaking included)
        HardCriticConfig(id="tremor", weight=0.5),
        # dropout frames that corrupt min/max normalisation, idle-arm drift, copied actions
        HardCriticConfig(id="normalization", weight=1.0),
        # spatial diversity of grasp positions across the run; informational (weight 0)
        HardCriticConfig(id="diversity", weight=0.0),
    ]


def default_indicators(task: TaskSpec, purpose: Purpose = "recording") -> list[SoftIndicator]:
    obj = next((o.name for o in task.objects if o.role == "target_object"), "the target object")
    zone = next((o.name for o in task.objects if o.role == "target_zone"), "the target zone")
    if purpose == "evaluation":
        return [
            SoftIndicator(
                id="object_in_target",
                description=f"At the end of the first completed attempt {obj} rests upright inside/on {zone} "
                "and stays there after release.",
                rubric=f"1.0 = upright in/on {zone}; 0.5 = in {zone} but tipped or half outside; "
                "0.0 = never placed, dropped or knocked over",
                weight=3.0,
                gate=True,
                gate_below=0.5,
            ),
            SoftIndicator(
                id="correct_object",
                description=f"The robot picks {obj}, not a distractor.",
                weight=1.0,
            ),
            SoftIndicator(
                id="no_disturbance",
                description="No collision, drop or knocked-over object BEFORE the first correct placement; "
                "nothing after it counts.",
                weight=0.5,
            ),
        ]
    return [
        SoftIndicator(
            id="correct_object",
            description=f"The robot identifies and manipulates the correct object ({obj}), not a distractor.",
            weight=1.0,
        ),
        SoftIndicator(
            id="grasp_centered",
            description=f"{obj} is grasped stably and centred in the hand/gripper; no slipping, tilting or re-grasp.",
            weight=1.0,
        ),
        SoftIndicator(
            id="object_in_target",
            description=f"At the end of each attempt {obj} rests inside/on {zone} in a stable, upright pose.",
            weight=2.0,
            gate=True,
            gate_below=0.3,
        ),
        SoftIndicator(
            id="visibility",
            description=f"{obj} and {zone} stay visible in the cameras during the manipulation (not out of frame or hidden).",
            weight=0.5,
        ),
        SoftIndicator(
            id="no_disturbance",
            description="No collisions, drops, dangerous motions, or people/hands other than the robot's in the workspace while the robot acts.",
            weight=1.0,
        ),
    ]


def default_scoring(purpose: Purpose = "recording") -> dict[str, Any]:
    """The scoring fields whose default depends on the purpose (``ScoringConfig`` carries the
    recording values as its own defaults)."""
    if purpose == "evaluation":
        return {
            # a failed task and a person in the loop are the two things a reviewer must see; a major
            # anomaly after the task was done (a second pick that collides) is not a failure
            "review_flags": ["VLM_TASK_FAILED", "HUMAN_IN_WORKSPACE"],
            # rollouts are not a recording session: no outlier flags against the run
            "relative_flags": False,
        }
    return {}
