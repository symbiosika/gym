"""A run judges each episode against a corrected prompt when one is given (GYM's prompt tool)."""

from lerobot_critics.critics.soft import vlm
from lerobot_critics.dataset import open_dataset
from lerobot_critics.runner import RunOptions, run
from lerobot_critics.spec.autospec import auto_spec

RECORDED = "put the red block in the box"


def test_loader_lays_prompts_over_the_recorded_task(synthetic_dataset):
    ds = open_dataset(synthetic_dataset, {1: "pick the blue cup"})
    assert ds.episode(1).task == "pick the blue cup"
    assert ds.episode(1).recorded_task == RECORDED
    assert ds.episode(0).task == RECORDED
    assert ds.task_for(1) == "pick the blue cup" and ds.recorded_task_for(1) == RECORDED
    assert ds.has_varying_tasks
    assert not open_dataset(synthetic_dataset).has_varying_tasks


def test_run_judges_against_the_corrected_prompt(synthetic_dataset, spec, tmp_path, monkeypatch):
    seen: dict[int, tuple[str, bool]] = {}

    def fake(self, ep, hard=None):
        seen[ep.index] = (ep.task, ep.ds.has_varying_tasks)
        return {}, []

    monkeypatch.setattr(vlm.VLMJudge, "judge", fake)
    spec.soft_critics.vlm.provider = "gemini"
    spec.soft_critics.vlm.mode = "frames"
    spec.soft_critics.only_hard_passed = False
    prompts = {0: "pick the blue cup", 2: "pick the green cup"}
    rep = run(
        synthetic_dataset,
        spec,
        RunOptions(out_dir=str(tmp_path), contact_sheets=False, workers=2, prompts=prompts),
    )
    by_ep = {e.episode: e for e in rep.episodes}
    assert by_ep[0].task == "pick the blue cup" and by_ep[0].recorded_task == RECORDED
    assert by_ep[2].task == "pick the green cup"
    assert by_ep[1].task == RECORDED and by_ep[1].recorded_task is None
    assert seen[0] == ("pick the blue cup", True)
    # the diversity critic counts the prompts the episodes are judged with
    cue = next(r for r in by_ep[0].hard if r.id == "diversity").metrics.get("cue_features") or {}
    assert cue.get("prompt") == "pick the blue cup"


def test_auto_spec_sees_the_corrected_prompts(synthetic_dataset):
    one = auto_spec(synthetic_dataset)
    assert not one.task.notes
    several = auto_spec(synthetic_dataset, prompts={0: "pick the blue cup"})
    assert "2 distinct" in several.task.notes
