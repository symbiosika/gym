import json

import pytest

from lerobot_critics.critics.soft.prompts import build_prompt, response_schema
from lerobot_critics.critics.soft.providers import _extract_json
from lerobot_critics.critics.soft.vlm import VLMJudge
from lerobot_critics.spec.models import CriticSpec, TaskObject, load_spec, save_spec


def test_spec_defaults_and_roundtrip(tmp_path):
    spec = CriticSpec.model_validate({"task": {"instruction": "stack the cups"}})
    ids = [c.id for c in spec.hard_critics]
    assert "tracking_error" in ids and "duplication" in ids
    assert spec.soft_critics.indicators and spec.soft_critics.indicators[0].id == "correct_object"
    p = tmp_path / "s.yaml"
    save_spec(spec, p)
    spec2 = load_spec(p)
    assert spec2 == spec
    (tmp_path / "s.json").write_text(spec.model_dump_json())
    assert load_spec(tmp_path / "s.json") == spec


def test_duplicate_hard_ids_rejected():
    with pytest.raises(ValueError):
        CriticSpec.model_validate(
            {"task": {"instruction": "x"}, "hard_critics": [{"id": "duration"}, {"id": "duration"}]}
        )


def test_prompt_and_schema(spec):
    prompt = build_prompt(spec, ["cam_a", "cam_b"], "cam_a", "top: cam_a; bottom: cam_b", 12.3)
    assert "put the red block in the box" in prompt
    for ind in spec.soft_critics.indicators:
        assert ind.id in prompt
    schema = response_schema(spec)
    assert set(schema["properties"]["indicators"]["properties"]) == {
        i.id for i in spec.soft_critics.indicators
    }


def test_extract_json():
    assert _extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert _extract_json('noise {"a": {"b": 2}} tail') == {"a": {"b": 2}}
    with pytest.raises(ValueError):
        _extract_json("nothing here")


def test_vlm_results_from_payload(spec, tmp_path):
    judge = VLMJudge(spec, tmp_path)
    inds = {i.id: {"score": 1.0, "confidence": 0.9, "evidence": "ok"} for i in spec.soft_critics.indicators}
    inds["object_in_target"] = {"score": 0.1, "confidence": 0.8, "evidence": "block fell at 3s"}
    payload = {
        "data": {
            "indicators": inds,
            "attempts": [{"grasp_time_s": 1, "release_time_s": 3, "placed_correctly": False}],
            "anomalies": [
                {"type": "drop", "time_s": 3.0, "severity": "major", "description": "block dropped"}
            ],
            "task_success": False,
            "confidence": 0.8,
            "summary": "failed",
        },
        "model": "m",
        "mode": "agentic",
        "usage": {"total_tokens": 10},
        "latency_s": 1.0,
    }
    res = judge.to_results(payload)
    by = {r.id: r for r in res}
    assert by["vlm.object_in_target"].gate_failed is True
    assert by["vlm.object_in_target"].score == 0.1
    assert "VLM_TASK_FAILED" in by["vlm.summary"].flags and "VLM_MAJOR_ANOMALY" in by["vlm.summary"].flags
    assert by["vlm.summary"].weight == 0.0
    json.dumps([r.model_dump() for r in res])


def test_composite_and_frames(synthetic_dataset, spec, tmp_path):
    from lerobot_critics.critics.soft.vlm import ensure_composite, sample_frames
    from lerobot_critics.dataset import open_dataset
    from lerobot_critics.dataset.video import probe_video

    ds = open_dataset(synthetic_dataset)
    ep = ds.episode(0)
    path = ensure_composite(ep, spec, tmp_path, fps=5, scale=1.0)
    info = probe_video(path)
    assert info.frames >= 25 and info.width == 160 and info.height == 120 + 120  # front on top, wrist below
    assert "scan" in ep.cache  # produced in the same pass
    frames = sample_frames(ep, spec, 6)
    assert len(frames) >= 6 and frames[0][1].shape[1] > frames[0][1].shape[0]


def test_prompt_uses_per_episode_task(spec):
    """A dataset with varying tasks is judged per episode, not against the static instruction."""
    spec = spec.model_copy(deep=True)
    spec.task.objects = [TaskObject(name="red_block", role="target_object", description="the red one")]
    ep_task = "Pick up the smaller orange cube and place it in the black box"
    prompt = build_prompt(spec, ["cam_a"], "cam_a", "cam_a", 10.0, episode_task=ep_task, task_varies=True)
    assert ep_task in prompt
    assert "put the red block in the box" not in prompt
    # the spec-level object list must not be presented as this episode's target any more
    assert "not this episode" in prompt


def test_prompt_auto_keeps_spec_instruction_for_single_task_dataset(spec):
    """`auto`: a dataset with one task keeps the spec's (usually better-written) instruction."""
    prompt = build_prompt(spec, ["cam_a"], "cam_a", "cam_a", 10.0, episode_task="terse pick task")
    assert "put the red block in the box" in prompt
    assert "terse pick task" not in prompt


def test_prompt_per_episode_always_and_never(spec):
    always = spec.model_copy(deep=True)
    always.task.per_episode = "always"
    prompt = build_prompt(always, ["cam_a"], "cam_a", "cam_a", 10.0, episode_task="terse pick task")
    assert "terse pick task" in prompt and "put the red block in the box" not in prompt

    never = spec.model_copy(deep=True)
    never.task.per_episode = "never"
    prompt = build_prompt(
        never, ["cam_a"], "cam_a", "cam_a", 10.0, episode_task="terse pick task", task_varies=True
    )
    assert "put the red block in the box" in prompt and "terse pick task" not in prompt


def test_prompt_falls_back_to_spec_instruction_without_episode_task(spec):
    spec = spec.model_copy(deep=True)
    spec.task.objects = [TaskObject(name="red_block", role="target_object", description="the red one")]
    for ep_task in (None, "", "   "):
        prompt = build_prompt(spec, ["cam_a"], "cam_a", "cam_a", 10.0, episode_task=ep_task, task_varies=True)
        assert "put the red block in the box" in prompt
        assert "not this episode" not in prompt
