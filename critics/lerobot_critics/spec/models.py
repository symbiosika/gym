"""The normalized critic specification.

A spec says *what* should be checked for a task: the task text and objects (used
to build the VLM prompt), the success indicators the VLM should judge (soft
critics, each with a weight), and the technical checks with their weights and
thresholds (hard critics). Everything has defaults so a minimal spec is just the
task instruction.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator

# What the episodes are: demonstrations for training (a recording) or rollouts of a trained
# policy (an evaluation). The purpose sets the defaults of everything a spec leaves out (which
# checks weigh on the score, what caps a verdict), the framing of the VLM judge and the wording
# of the reports. A field the spec sets explicitly wins over the purpose's default.
Purpose = Literal["recording", "evaluation"]


class TaskObject(BaseModel):
    name: str
    description: str = ""
    role: Literal["target_object", "target_zone", "distractor", "tool", "other"] = "other"


class TaskSpec(BaseModel):
    instruction: str = Field(
        ..., description='Natural-language task, e.g. "put the red cube in the black box"'
    )
    per_episode: Literal["auto", "always", "never"] = Field(
        "auto",
        description="Whether to judge an episode against the task recorded for it in the dataset "
        "instead of `instruction`. auto = only when the dataset records more than one distinct "
        "task (then no single instruction can describe every episode); always = whenever the "
        "episode carries a task; never = always use `instruction`.",
    )
    scene: str = Field("", description="Free-text description of the environment for the VLM")
    objects: list[TaskObject] = Field(default_factory=list)
    expected_cycles: int | None = Field(
        None, description="Expected pick-and-place repetitions per episode (None = unknown / single)"
    )
    notes: str = Field("", description="Extra hints for the VLM judge (recording protocol, what is normal)")

    @field_validator("per_episode", mode="before")
    @classmethod
    def _per_episode_bool(cls, v: Any) -> Any:
        """Accept the `true`/`false` a YAML author reaches for on a three-state flag."""
        if isinstance(v, bool):
            return "always" if v else "never"
        return v


class GripperSpec(BaseModel):
    """Which signal encodes hand/gripper closure."""

    feature: str | None = Field(None, description="State feature key (auto-detected when None)")
    dims: list[int] | None = Field(None, description="Dimensions to average (None = all)")
    closed_is_high: bool = True
    min_swing: float | None = Field(
        None, description="Absolute swing that counts as an open/close; None = 35% of range"
    )


class RobotSpec(BaseModel):
    type: str | None = None
    active_arms: list[str] = Field(default_factory=list, description='Arm names e.g. ["left"]; empty = all')
    action_state_pairs: dict[str, str] | None = Field(
        None, description="Explicit action->state feature mapping; auto-detected when None"
    )
    cartesian_features: list[str] | None = Field(
        None, description="Features whose first 3 dims are xyz in metres (auto-detected: eef_pose / 'wrist')"
    )
    gripper: GripperSpec = Field(default_factory=GripperSpec)
    primary_camera: str | None = Field(
        None, description="Camera shown large in the VLM composite; auto = non-wrist"
    )
    preroll_min_s: float | None = Field(
        1.0,
        description="A leading span of at least this many seconds in which the arm command is all zero "
        "while the state is valid is the start-up delay of the controller or policy (the pre-roll): the "
        "signal critics measure from its end and report it, instead of reading it as dropout frames, "
        "tracking error, frozen commands and a spike. Shorter spans stay dropouts. None switches the "
        "detection off.",
    )


class HardCriticConfig(BaseModel):
    id: str
    weight: float = 1.0
    enabled: bool = True
    gate: bool = Field(False, description="If true, a failing critic rejects the episode regardless of score")
    gate_below: float = Field(0.2, description="Score below which the gate fires (only when gate=true)")
    gate_flags: list[str] = Field(
        default_factory=list,
        description="Flags that reject the episode outright when raised (flag-driven gate)",
    )
    params: dict[str, Any] = Field(default_factory=dict)

    @field_validator("weight")
    @classmethod
    def _nonneg(cls, v: float) -> float:
        if v < 0:
            raise ValueError("weight must be >= 0")
        return v


class SoftIndicator(BaseModel):
    id: str
    description: str
    weight: float = 1.0
    gate: bool = False
    gate_below: float = 0.3
    rubric: str = Field("", description="Optional scoring rubric for the VLM (what is 1.0, 0.5, 0.0)")


class VLMConfig(BaseModel):
    provider: Literal["gemini", "openai_compatible", "none"] = "gemini"
    model: str = "gemini-3.7-flash"
    mode: Literal["agentic", "static", "frames"] = Field(
        "agentic",
        description="agentic/static = Gemini native video; frames = sampled JPEG frames (any image model)",
    )
    base_url: str | None = Field(None, description="OpenAI-compatible endpoint (OpenRouter, vLLM, Ollama)")
    api_key_env: str | None = Field(None, description="Env var holding the API key (defaults per provider)")
    composite_fps: float = Field(
        5.0, description="Frame rate of the multi-camera composite video sent to the VLM"
    )
    composite_scale: float = Field(1.0, description="Scale factor for the primary camera in the composite")
    frames_per_episode: int = Field(24, description="Frames sampled when mode=frames")
    temperature: float = 0.0
    max_concurrency: int = 4
    timeout_s: float = 300.0
    cache: bool = True


class SoftCriticsConfig(BaseModel):
    enabled: bool = True
    weight: float = Field(1.0, description="Weight of the whole soft group relative to the hard group")
    vlm: VLMConfig = Field(default_factory=VLMConfig)
    indicators: list[SoftIndicator] = Field(default_factory=list)
    extra_questions: list[str] = Field(
        default_factory=list, description="Additional free-form things the VLM should report in 'anomalies'"
    )


class ScoringConfig(BaseModel):
    hard_weight: float = 1.0
    soft_weight: float = 1.0
    accept_threshold: float = Field(0.75, description="Total score >= this and no gate fired -> accept")
    review_threshold: float = Field(0.55, description="Between review and accept -> review; below -> reject")
    relative_flags: bool = Field(True, description="Also emit dataset-relative robust-z outlier flags")
    z_cut: float = 3.0
    review_flags: list[str] = Field(
        default_factory=lambda: [
            "VLM_TASK_FAILED",
            "VLM_MAJOR_ANOMALY",
            "HUMAN_IN_WORKSPACE",
            "UNFINISHED_GRASP",
            "ZERO_FRAMES",
        ],
        description="Flags that cap the verdict at 'review' even when the score would accept",
    )
    reject_flags: list[str] = Field(
        default_factory=list, description="Flags that force 'reject' (in addition to gates)"
    )
    ignore_flags: list[str] = Field(
        default_factory=list,
        description="Flags to switch off for this dataset: they are dropped before gates, review "
        "caps and the reports, as if the finding had never been raised. Use it for findings that "
        "are irrelevant for your setup (e.g. INACTIVE_ARM_TRACKERR when the second arm is unused). "
        "It removes the *verdict* effect of a flag, not the score its critic gave - lower that "
        "critic's weight or set enabled=false if the score should go too.",
    )


class CriticSpec(BaseModel):
    version: int = 1
    name: str = "default"
    purpose: Purpose = Field(
        "recording",
        description="recording = teleoperated demonstrations judged as training data; evaluation = rollouts "
        "of a trained policy judged on the outcome of the task. Sets the defaults, the judge's framing "
        "and the report wording; explicit fields win.",
    )
    task: TaskSpec
    robot: RobotSpec = Field(default_factory=RobotSpec)
    hard_critics: list[HardCriticConfig] = Field(default_factory=list)
    soft_critics: SoftCriticsConfig = Field(default_factory=SoftCriticsConfig)
    scoring: ScoringConfig = Field(default_factory=ScoringConfig)

    @model_validator(mode="after")
    def _fill_defaults(self) -> CriticSpec:
        from .defaults import default_hard_critics, default_indicators, default_scoring

        if not self.hard_critics:
            self.hard_critics = default_hard_critics(self.purpose)
        else:
            ids = {c.id for c in self.hard_critics}
            if len(ids) != len(self.hard_critics):
                raise ValueError("duplicate hard critic ids")
        if self.soft_critics.enabled and not self.soft_critics.indicators:
            self.soft_critics.indicators = default_indicators(self.task, self.purpose)
        # scoring fields the spec did not set follow the purpose (a validated spec has them all
        # set, so a round trip through YAML keeps what was decided here)
        for key, value in default_scoring(self.purpose).items():
            if key not in self.scoring.model_fields_set:
                setattr(self.scoring, key, value)
        return self

    @property
    def is_evaluation(self) -> bool:
        return self.purpose == "evaluation"

    def hard(self, cid: str) -> HardCriticConfig | None:
        return next((c for c in self.hard_critics if c.id == cid), None)

    def to_yaml(self) -> str:
        return yaml.safe_dump(json.loads(self.model_dump_json()), sort_keys=False, allow_unicode=True)


def load_spec(path_or_obj: str | Path | dict[str, Any], purpose: Purpose | None = None) -> CriticSpec:
    """Read a spec; ``purpose`` overrides the stored one (the kind of a run is a fact of the run,
    not of the spec: one spec describes the task, the run says whether these episodes are
    demonstrations or rollouts)."""
    if isinstance(path_or_obj, dict):
        data = dict(path_or_obj)
    else:
        p = Path(path_or_obj)
        text = p.read_text()
        data = json.loads(text) if p.suffix == ".json" else yaml.safe_load(text)
    if purpose is not None:
        data["purpose"] = purpose
    return CriticSpec.model_validate(data)


def save_spec(spec: CriticSpec, path: str | Path) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.suffix == ".json":
        p.write_text(spec.model_dump_json(indent=2))
    else:
        p.write_text(spec.to_yaml())
