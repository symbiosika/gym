import json

import numpy as np

from lerobot_critics.critics.base import CriticResult
from lerobot_critics.runner import RunOptions, run
from lerobot_critics.scoring import aggregate, robust_z
from lerobot_critics.spec.models import ScoringConfig


def _r(id, score, weight=1.0, gate=False, gate_below=0.2, kind="hard"):
    return CriticResult(
        id=id,
        kind=kind,
        weight=weight,
        score=score,
        gate=gate,
        gate_below=gate_below,
        gate_failed=bool(gate and score is not None and score < gate_below),
    )


def test_robust_z():
    z = robust_z(np.array([1, 1, 1, 1, 10.0]))
    assert z[-1] > 3 and abs(z[0]) < 1e-9
    assert np.all(robust_z(np.array([2.0, 2.0, 2.0])) == 0)


def test_aggregate_weights_and_gates():
    cfg = ScoringConfig(accept_threshold=0.75, review_threshold=0.55)
    s = aggregate(0, [_r("a", 1.0, 1), _r("b", 0.5, 1)], [_r("v", 1.0, 2, kind="soft")], cfg)
    assert abs(s.hard_score - 0.75) < 1e-9 and s.soft_score == 1.0 and abs(s.total - 0.875) < 1e-9
    assert s.verdict == "accept"
    s = aggregate(1, [_r("a", 0.1, 1, gate=True)], [], cfg)
    assert s.verdict == "reject" and s.gates_failed == ["a"]
    s = aggregate(2, [_r("a", 0.6)], [], cfg)
    assert s.verdict == "review"
    s = aggregate(3, [_r("a", None)], [], cfg)
    assert s.total is None and s.verdict == "review"
    # weight-0 results (informational) never influence the mean
    s = aggregate(4, [_r("a", 1.0)], [_r("info", 0.0, 0.0, kind="soft")], cfg)
    assert s.soft_score is None and s.total == 1.0


def test_runner_end_to_end(synthetic_dataset, spec, tmp_path):
    out = tmp_path / "out"
    rep = run(synthetic_dataset, spec, RunOptions(out_dir=str(out), workers=1, run_soft=False))
    assert rep.n_episodes == 4
    verdict = {e.episode: e.score.verdict for e in rep.episodes}
    assert verdict[0] == "accept" and verdict[1] == "accept"
    assert verdict[2] in ("reject", "review")
    assert verdict[3] in ("reject", "review")
    assert 0 in rep.include
    for name in ("report.json", "report.md", "episodes.csv", "selection.json"):
        assert (out / name).is_file(), name
    sel = json.loads((out / "selection.json").read_text())
    assert set(sel) >= {"include", "review", "exclude", "reasons"}
    assert (out / "sheets").is_dir()
    md = (out / "report.md").read_text()
    assert "Verdicts" in md and "Episode 3" in md


def test_runner_parallel_and_subset(synthetic_dataset, spec, tmp_path):
    rep = run(
        synthetic_dataset,
        spec,
        RunOptions(
            out_dir=str(tmp_path / "o"), workers=2, run_soft=False, episodes=[0, 2], contact_sheets=False
        ),
    )
    assert [e.episode for e in rep.episodes] == [0, 2]


def test_sample_episodes_spreads_over_the_session():
    from lerobot_critics.runner import sample_episodes

    assert sample_episodes(list(range(10)), None) == list(range(10))
    assert sample_episodes(list(range(10)), 20) == list(range(10))
    assert sample_episodes(list(range(10)), 1) == [0]
    assert sample_episodes(list(range(10)), 2) == [0, 9]
    assert sample_episodes(list(range(10)), 4) == [0, 3, 6, 9]
    picked = sample_episodes(list(range(100)), 7)
    assert len(picked) == len(set(picked)) == 7 and picked == sorted(picked)
