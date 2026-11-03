from lerobot_critics.critics.soft import vlm
from lerobot_critics.runner import RunOptions, run


def test_soft_critics_skip_hard_rejects(synthetic_dataset, spec, tmp_path, monkeypatch):
    judged = []

    def fake(self, ep, hard=None):
        judged.append(ep.index)
        return {}, []

    monkeypatch.setattr(vlm.VLMJudge, "judge", fake)
    spec.soft_critics.vlm.provider = "gemini"
    spec.soft_critics.vlm.mode = "frames"
    spec.soft_critics.only_hard_passed = True
    rep = run(synthetic_dataset, spec, RunOptions(out_dir=str(tmp_path), contact_sheets=False))
    rejected = {e.episode for e in rep.episodes if e.score.verdict == "reject"}
    assert rejected and not (set(judged) & rejected)
    assert judged
    # skipped episodes carry no soft result and no error
    assert all(not e.soft for e in rep.episodes if e.episode in rejected)
