"""On a recording the VLM alone never rejects an episode: what only the model says caps the
episode at review, a person decides. A reject needs the signal critics (a hard gate, a reject
flag a hard critic raised, or a hard score below the review threshold). On an evaluation the
model's judgement of the outcome is the point, so there it may reject (``soft_can_reject``)."""

from lerobot_critics.critics.base import CriticResult
from lerobot_critics.scoring import SOFT_CAP_PREFIX, aggregate
from lerobot_critics.spec.models import CriticSpec, ScoringConfig, TaskSpec


def _r(id, score, kind="hard", gate=False, gate_below=0.3, flags=(), weight=1.0):
    return CriticResult(
        id=id,
        kind=kind,
        weight=weight,
        score=score,
        gate=gate,
        gate_below=gate_below,
        gate_failed=bool(gate and score is not None and score < gate_below),
        flags=list(flags),
    )


GOOD_HARD = [_r("tracking_error", 1.0), _r("tremor", 0.9)]


def test_a_soft_gate_alone_caps_at_review():
    s = aggregate(0, GOOD_HARD, [_r("vlm.object_in_target", 0.0, "soft", gate=True)], ScoringConfig())
    assert s.verdict == "review"
    assert s.gates_failed == ["vlm.object_in_target"]
    assert s.reasons[0].startswith(SOFT_CAP_PREFIX) and "vlm.object_in_target" in s.reasons[0]


def test_a_soft_score_dragging_the_total_down_caps_at_review():
    soft = [_r("vlm.a", 0.0, "soft"), _r("vlm.b", 0.0, "soft")]
    s = aggregate(0, GOOD_HARD, soft, ScoringConfig(soft_weight=3.0))
    assert s.total < 0.55 and s.verdict == "review"
    assert s.reasons[0].startswith(SOFT_CAP_PREFIX)


def test_a_soft_reject_flag_caps_at_review_and_a_hard_one_rejects():
    cfg = ScoringConfig(reject_flags=["VLM_TASK_FAILED", "TREMOR"])
    soft = [_r("vlm.summary", 0.0, "soft", flags=["VLM_TASK_FAILED"], weight=0.0)]
    assert aggregate(0, GOOD_HARD, soft, cfg).verdict == "review"
    hard = [_r("tracking_error", 1.0), _r("tremor", 0.6, flags=["TREMOR"])]
    assert aggregate(0, hard, soft, cfg).verdict == "reject"


def test_the_hard_critics_still_reject():
    gate = [_r("tracking_error", 0.1, gate=True)]
    assert aggregate(0, gate, [_r("vlm.a", 1.0, "soft")], ScoringConfig()).verdict == "reject"
    low = [_r("tracking_error", 0.3), _r("tremor", 0.3)]
    s = aggregate(0, low, [_r("vlm.a", 0.0, "soft", gate=True)], ScoringConfig())
    assert s.verdict == "reject" and not any(r.startswith(SOFT_CAP_PREFIX) for r in s.reasons)


def test_without_any_hard_score_the_soft_critics_cannot_reject():
    s = aggregate(0, [], [_r("vlm.a", 0.0, "soft", gate=True)], ScoringConfig())
    assert s.verdict == "review"


def test_soft_can_reject_keeps_the_old_behaviour():
    cfg = ScoringConfig(soft_can_reject=True)
    assert aggregate(0, GOOD_HARD, [_r("vlm.a", 0.0, "soft", gate=True)], cfg).verdict == "reject"


def test_the_default_follows_the_purpose_and_an_explicit_value_wins():
    task = TaskSpec(instruction="pick")
    assert CriticSpec(task=task).scoring.soft_can_reject is False
    assert CriticSpec(task=task, purpose="evaluation").scoring.soft_can_reject is True
    explicit = CriticSpec(task=task, purpose="evaluation", scoring=ScoringConfig(soft_can_reject=False))
    assert explicit.scoring.soft_can_reject is False


def test_the_reason_row_says_the_model_alone_would_reject(synthetic_dataset, spec, tmp_path):
    from lerobot_critics.runner import RunOptions, run
    from lerobot_critics.selection import episode_reason

    rep = run(synthetic_dataset, spec, RunOptions(out_dir=str(tmp_path / "out"), workers=1, run_soft=False))
    r = next(e for e in rep.episodes if e.score.verdict == "accept")
    soft = [_r("vlm.object_in_target", 0.0, "soft", gate=True)]
    r = r.model_copy(update={"soft": soft, "score": aggregate(r.episode, r.hard, soft, ScoringConfig())})
    row = episode_reason(rep, r)
    assert row["verdict"] == "review" and row["cause"] == "soft"
    assert "vlm.object_in_target" in row["headline"] and "person" in row["headline"]
