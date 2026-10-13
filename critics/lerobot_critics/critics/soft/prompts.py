"""Prompt + JSON schema construction for the VLM judge, driven entirely by the spec."""

from __future__ import annotations

import json
from typing import Any

from ...spec.models import CriticSpec

SYSTEM_ROLE = (
    "You are a meticulous robotics data-quality judge. You review recordings of teleoperated robot "
    "episodes that are candidates for imitation-learning training data. Be strict and literal: score only "
    "what is visible. Use the burned-in time stamps (t=...s) when citing evidence. Never invent events."
)

SYSTEM_ROLE_EVALUATION = (
    "You are a meticulous robotics evaluation judge. You review recordings of a trained robot policy "
    "running on its own (policy rollouts) and decide whether the task was accomplished. Judge the outcome, "
    "not the style: slow, hesitant or inelegant motion is not a failure. Be strict and literal: score only "
    "what is visible. Use the burned-in time stamps (t=...s) when citing evidence. Never invent events."
)


def system_role(spec: CriticSpec) -> str:
    """The judge's framing: training data for a recording, a policy rollout for an evaluation."""
    return SYSTEM_ROLE_EVALUATION if spec.is_evaluation else SYSTEM_ROLE


def indicator_block(spec: CriticSpec) -> str:
    lines = []
    for ind in spec.soft_critics.indicators:
        rub = f" Rubric: {ind.rubric}" if ind.rubric else ""
        lines.append(f'- "{ind.id}": {ind.description}{rub}')
    return "\n".join(lines)


def effective_instruction(
    spec: CriticSpec, episode_task: str | None = None, task_varies: bool = False
) -> str:
    """The instruction this episode is judged against.

    Under ``per_episode: auto`` (the default) the dataset's own task text wins as soon as the
    dataset records more than one distinct task: no single instruction can describe every episode
    there, and judging them all against one - a scripted eval rollout that varies the prompt per
    episode especially - makes every differently-prompted episode read as a wrong-object failure.
    A dataset with one task keeps the spec's instruction, which is usually the better-written one.
    """
    task = (episode_task or "").strip()
    mode = spec.task.per_episode
    if task and (mode == "always" or (mode == "auto" and task_varies)):
        return task
    return spec.task.instruction


def scene_block(
    spec: CriticSpec,
    cameras: list[str],
    primary: str | None,
    layout: str,
    episode_task: str | None = None,
    task_varies: bool = False,
) -> str:
    t = spec.task
    instruction = effective_instruction(spec, episode_task, task_varies)
    objs = (
        "\n".join(
            f"  - {o.name} ({o.role.replace('_', ' ')}){': ' + o.description if o.description else ''}"
            for o in t.objects
        )
        or "  (not specified)"
    )
    # The object list is spec-level, i.e. one inventory for the whole recording session. When this
    # episode's instruction is not the spec's, the object named as the target belongs to a different
    # episode and must not override the instruction.
    if t.objects and instruction != t.instruction:
        objs += (
            "\n  (this list describes the recording session, not this episode - the target object and"
            " target zone for THIS episode are the ones named in the instruction above)"
        )
    cyc = (
        f"The episode is expected to contain {t.expected_cycles} repetitions of the task (the scene is reset in between)."
        if t.expected_cycles
        else "The episode may contain one or several repetitions of the task."
    )
    who = "policy" if spec.is_evaluation else "operator"
    return (
        f'Task instruction given to the {who}: "{instruction}"\n'
        f"Scene: {t.scene or '(not specified)'}\n"
        f"Objects:\n{objs}\n"
        f"{cyc}\n"
        f"{('Notes: ' + t.notes) if t.notes else ''}\n"
        f"Video layout: {layout}\n"
    )


def build_prompt(
    spec: CriticSpec,
    cameras: list[str],
    primary: str | None,
    layout: str,
    duration_s: float,
    episode_task: str | None = None,
    task_varies: bool = False,
    preroll_s: float = 0.0,
) -> str:
    """The whole prompt for one episode. ``preroll_s`` is the start-up delay the signal critics
    found (see ``dataset.preroll``): the model is told the still start is normal, so it is not
    reported as a freeze or a hesitation."""
    extra = ""
    if spec.soft_critics.extra_questions:
        extra = (
            "Additionally report in 'anomalies' if you observe: "
            + "; ".join(spec.soft_critics.extra_questions)
            + ".\n"
        )
    still = ""
    if preroll_s and preroll_s > 0:
        still = (
            f"The robot stands still for the first {preroll_s:.1f} s of the episode while the controller starts "
            "up; that is normal and neither a hesitation, a freeze nor an anomaly.\n"
        )
    if spec.is_evaluation:
        judge = (
            "Judge the outcome of the task, not the style of the motion: slow, hesitant, roundabout or inelegant "
            "execution is not a failure; a wrong, dropped, knocked-over or misplaced object is.\n"
        )
        anomalies = (
            "Also report anomalies: drops, collisions, re-grasps, objects knocked over, the robot hitting the table, "
            "the robot freezing or making no progress, a person or human hand inside the workspace while the robot "
            "is moving (an intervention invalidates the rollout; humans resetting the scene BETWEEN attempts while "
            "the robot idles are normal and must be listed as 'scene_reset', not as a failure), and camera problems "
            "(frozen, dark, blown out, obstructed). Say when each one happened: an anomaly after the task was "
            "completed does not undo the success.\n"
        )
        decide = (
            "Finally decide task_success: true only if the task instruction was fully achieved (in every expected "
            "repetition); what the robot does after the task is done does not change it.\n"
        )
    else:
        judge = ""
        anomalies = (
            "Also report anomalies: drops, collisions, re-grasps, objects knocked over, the robot hitting the table, "
            "a person or human hand inside the workspace while the robot is moving (humans resetting the scene BETWEEN "
            "attempts while the robot idles are normal and must be listed as 'scene_reset', not as a failure), "
            "camera problems (frozen, dark, blown out, obstructed), and anything that would make the episode a bad "
            "training demonstration.\n"
        )
        decide = "Finally decide task_success: true only if the task instruction was fully achieved in every attempt.\n"
    return (
        f"{system_role(spec)}\n\n"
        f"{scene_block(spec, cameras, primary, layout, episode_task, task_varies)}"
        f"The episode lasts {duration_s:.1f} s.\n"
        f"{still}\n"
        "Watch the whole episode. First list every task attempt (cycle) you can see with the time the object is "
        "grasped, the time it is released, and whether that attempt ended with the object correctly placed.\n"
        "Then score each of the following success indicators from 0.0 (clearly violated) to 1.0 (clearly satisfied), "
        "aggregated over all attempts in the episode (if one of five attempts fails, the indicator is at most 0.8). "
        "Give one sentence of evidence with time stamps per indicator, and a confidence 0..1 in your own judgement.\n"
        f"{judge}"
        f"{indicator_block(spec)}\n\n"
        f"{anomalies}"
        f"{extra}"
        f"{decide}"
        "Respond with JSON only, matching the schema."
    )


def response_schema(spec: CriticSpec) -> dict[str, Any]:
    ind_props = {
        ind.id: {
            "type": "object",
            "properties": {
                "score": {"type": "number"},
                "confidence": {"type": "number"},
                "evidence": {"type": "string"},
            },
            "required": ["score", "confidence", "evidence"],
        }
        for ind in spec.soft_critics.indicators
    }
    return {
        "type": "object",
        "properties": {
            "attempts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "grasp_time_s": {"type": "number"},
                        "release_time_s": {"type": "number"},
                        "placed_correctly": {"type": "boolean"},
                        "note": {"type": "string"},
                    },
                    "required": ["grasp_time_s", "release_time_s", "placed_correctly"],
                },
            },
            "indicators": {"type": "object", "properties": ind_props, "required": list(ind_props)},
            "anomalies": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string"},
                        "time_s": {"type": "number"},
                        "severity": {"type": "string", "enum": ["info", "minor", "major"]},
                        "description": {"type": "string"},
                    },
                    "required": ["type", "time_s", "severity", "description"],
                },
            },
            "task_success": {"type": "boolean"},
            "confidence": {"type": "number"},
            "summary": {"type": "string"},
        },
        "required": ["attempts", "indicators", "anomalies", "task_success", "confidence", "summary"],
    }


def schema_as_text(schema: dict[str, Any]) -> str:
    return "JSON schema:\n" + json.dumps(schema, indent=1)
