"""The three answers a finished run owes a person: which episodes to filter, why each one
was filtered, and what switching a criterion off would give back."""

from __future__ import annotations

import json

from test_visual_report import _ep, _report
from typer.testing import CliRunner

from lerobot_critics.cli import app
from lerobot_critics.critics.base import CriticResult
from lerobot_critics.report import build_selection, render_markdown
from lerobot_critics.runner import RunOptions, run
from lerobot_critics.scoring import REVIEW_CAP_PREFIX, ScoringConfig, aggregate, mute_flags
from lerobot_critics.selection import (
    apply_overrides,
    compact_ranges,
    episode_reason,
    filtered_episodes,
    flag_impact,
    impact_text,
    selection_lists,
    tuning_snippet,
    verdicts_with_ignored,
)
from lerobot_critics.spec.autospec import auto_spec
from lerobot_critics.visual_report import render_html_report


def _hard(cid: str, score: float, weight: float = 1.0, **kw) -> CriticResult:
    return CriticResult(id=cid, kind="hard", weight=weight, score=score, **kw)


def _sample():
    """12 clean accepts plus three filtered episodes, one per cause: gate, review flag, score.

    The critic results are the ones the verdicts are computed from, so the report is as
    self-consistent as a real run - ``flag_impact`` replays exactly these.
    """
    cfg = ScoringConfig(review_flags=["HUMAN_IN_WORKSPACE"])
    gate = {"gate": True, "gate_below": 0.1, "gate_failed": True}
    episodes = []
    for i in range(12):
        e = _ep(i, 0.98, "accept", hard=[_hard("smoothness", 0.98)])
        episodes.append(e)
    # 12: the score would accept, a review flag caps it
    episodes.append(
        _ep(
            12,
            0.9,
            "review",
            hard=[_hard("smoothness", 0.9, flags=["INACTIVE_ARM_TRACKERR"])],
        )
    )
    episodes[-1].soft = [
        CriticResult(id="vlm.summary", kind="soft", weight=0.0, flags=["HUMAN_IN_WORKSPACE"])
    ]
    # 13: a flag-driven gate rejects it; the score alone would only reach review
    episodes.append(
        _ep(
            13,
            0.6,
            "reject",
            hard=[
                _hard(
                    "duplication",
                    0.3,
                    flags=["LAGGY"],
                    evidence=["command vector frozen in 22% of frames, longest 9.3s"],
                    **gate,
                ),
                _hard("smoothness", 0.9),
            ],
        )
    )
    # 14: no flag decides anything, the score does
    episodes.append(
        _ep(
            14,
            0.44,
            "reject",
            hard=[_hard("tracking_error", 0.4, weight=1.5, flags=["JERKY"]), _hard("smoothness", 0.5)],
        )
    )
    for e in episodes:
        e.score = aggregate(e.episode, e.hard, e.soft, cfg)
    report = _report(episodes)
    report.spec["hard_critics"] = [
        {"id": "duplication", "gate": True, "gate_below": 0.1, "gate_flags": ["LAGGY"]},
        {"id": "smoothness", "weight": 1.0},
        {"id": "tracking_error", "weight": 1.5},
    ]
    report.spec["scoring"] = json.loads(cfg.model_dump_json())
    return report


def test_compact_ranges_is_the_form_a_filter_takes():
    assert compact_ranges([0, 1, 2, 4, 7, 8, 9]) == "0-2,4,7-9"
    assert compact_ranges([5]) == "5"
    assert compact_ranges([]) == ""
    assert compact_ranges([3, 1, 2, 2]) == "1-3"  # unsorted and duplicated input


def test_selection_lists_carry_numbers_and_ranges():
    lists = selection_lists(_sample())
    assert lists["accept"]["episodes"] == list(range(12)) and lists["accept"]["ranges"] == "0-11"
    assert lists["review"]["ranges"] == "12"
    assert lists["reject"]["ranges"] == "13-14" and lists["reject"]["n"] == 2


def test_every_filtered_episode_names_its_one_decisive_cause():
    report = _sample()
    rows = {d["episode"]: d for d in filtered_episodes(report)}
    assert set(rows) == {12, 13, 14}  # accepted episodes are not in the list

    # a gate: the flag that fired it is what you would have to switch off
    assert rows[13]["cause"] == "gate"
    assert rows[13]["blocking"] == ["LAGGY"]
    assert "duplication" in rows[13]["headline"] and "LAGGY" in rows[13]["headline"]
    assert rows[13]["details"] == ["command vector frozen in 22% of frames, longest 9.3s"]

    # a review flag on an otherwise accepted score
    assert rows[12]["cause"] == "flag"
    assert rows[12]["blocking"] == ["HUMAN_IN_WORKSPACE"]
    # the flag that did not decide anything stays out of "blocking" but is still reported
    assert "INACTIVE_ARM_TRACKERR" in rows[12]["flags"]
    assert REVIEW_CAP_PREFIX not in " ".join(rows[12]["details"])

    # the score alone: nothing to switch off
    assert rows[14]["cause"] == "score" and rows[14]["blocking"] == []
    assert "0.44" in rows[14]["headline"] and "tracking_error" in rows[14]["headline"]


def test_accepted_episode_has_no_cause():
    report = _sample()
    d = episode_reason(report, report.episodes[0])
    assert d["cause"] == "" and d["headline"] == "" and d["blocking"] == []


def test_filtered_episodes_are_ordered_worst_first():
    assert [d["episode"] for d in filtered_episodes(_sample())] == [14, 13, 12]


def test_flag_impact_replays_the_run_per_flag():
    rows = {d["flag"]: d for d in flag_impact(_sample())}
    # a review cap is fully recoverable: muting it accepts the episode
    assert rows["HUMAN_IN_WORKSPACE"]["decides"] == [12]
    assert rows["HUMAN_IN_WORKSPACE"]["would_accept"] == [12]
    assert impact_text(rows["HUMAN_IN_WORKSPACE"]) == "12 → accept"
    # a gate over a hopeless score is only partly recoverable - the replay says so
    assert rows["LAGGY"]["decides"] == [13] and rows["LAGGY"]["would_accept"] == []
    assert rows["LAGGY"]["would_improve"] == {13: "review"}
    assert rows["LAGGY"]["critics"] == ["duplication"]
    # a flag nobody filters on decides nothing, however often it occurs
    for flag in ("INACTIVE_ARM_TRACKERR", "JERKY"):
        assert rows[flag]["decides"] == [] and "informational" in rows[flag]["effect"]
    # most recoverable first
    assert list(rows)[0] == "HUMAN_IN_WORKSPACE"


def test_verdicts_with_ignored_leaves_the_untouched_episodes_alone():
    report = _sample()
    after = verdicts_with_ignored(report, {"HUMAN_IN_WORKSPACE"})
    assert after[12].verdict == "accept"
    assert "HUMAN_IN_WORKSPACE" not in after[12].flags
    assert after[13].verdict == "reject" and after[0].verdict == "accept"


def test_apply_overrides_downgrades_findings_and_can_be_taken_back():
    report = _sample()
    # LAGGY to review: the gate no longer fires, the flag stays on the episode as a warning;
    # the score alone (0.6) only reaches review, so 13 becomes review, not accept
    demoted = apply_overrides(report, ignore_flags=[], review_flags=["LAGGY"])
    ep13 = next(e for e in demoted.episodes if e.episode == 13)
    assert ep13.score.verdict == "review"
    assert ep13.score.gates_failed == [] and "LAGGY" in ep13.score.flags
    assert demoted.review == [12, 13] and demoted.exclude == [14]
    assert demoted.overrides == {"ignore_flags": [], "review_flags": ["LAGGY"], "disabled_critics": []}
    assert demoted.flag_counts["LAGGY"] == 1
    # selection.json reads the same verdicts: LAGGY no longer blocks 13, its cause is the score
    sel = build_selection(demoted)
    assert sel["reasons"]["13"]["cause"] == "score" and sel["reasons"]["13"]["blocking"] == []
    # HUMAN_IN_WORKSPACE muted: 12 is accepted and the flag is gone from its record
    muted = apply_overrides(report, ignore_flags=["HUMAN_IN_WORKSPACE"], review_flags=["LAGGY"])
    assert muted.include == list(range(13)) and "HUMAN_IN_WORKSPACE" not in muted.flag_counts
    assert muted.counts == {"accept": 13, "review": 1, "reject": 1}
    # the critic results are what the run found, so the overrides can be taken back
    raw = next(e for e in muted.episodes if e.episode == 12)
    assert any("HUMAN_IN_WORKSPACE" in c.flags for c in raw.soft)
    restored = apply_overrides(muted, ignore_flags=[], review_flags=[])
    assert restored.include == report.include and restored.exclude == report.exclude
    assert [e.score.verdict for e in restored.episodes] == [e.score.verdict for e in report.episodes]
    assert restored.overrides == {"ignore_flags": [], "review_flags": [], "disabled_critics": []}
    # a flag that is both ignored and demoted is ignored
    both = apply_overrides(report, ignore_flags=["LAGGY"], review_flags=["LAGGY"])
    assert both.overrides["review_flags"] == [] and "LAGGY" not in both.flag_counts


def test_apply_overrides_switches_a_critic_off_for_the_dataset():
    report = _sample()
    # 14 is rejected by its score alone: tracking_error 0.4 at weight 1.5 drags the total to 0.44.
    # Muting its flag (JERKY) changes nothing, because the flag decided nothing ...
    assert apply_overrides(report, ["JERKY"], []).exclude == [13, 14]
    # ... switching the critic off does: it has no weight, the total is the smoothness score alone
    # (0.5, still under the review threshold of 0.55, so 14 stays a reject on its own merits)
    off = apply_overrides(report, [], [], disabled_critics=["tracking_error"])
    ep14 = next(e for e in off.episodes if e.episode == 14)
    assert ep14.score.total == 0.5 and ep14.score.verdict == "reject"
    assert "JERKY" not in ep14.score.flags
    assert off.overrides["disabled_critics"] == ["tracking_error"]
    # the critic's own result is still on the record, for the reader
    assert next(c for c in ep14.hard if c.id == "tracking_error").score == 0.4
    # the reason no longer names the critic as the weakest
    reason = build_selection(off)["reasons"]["14"]
    assert reason["cause"] == "score" and "tracking_error" not in reason["why"]
    # a gating critic off: gate, flag and weight are gone, 13 is read from smoothness alone (0.9) and accepted
    off2 = apply_overrides(report, [], [], disabled_critics=["duplication"])
    assert 13 in off2.include and "LAGGY" not in off2.flag_counts
    # the whole model off by its group name
    off3 = apply_overrides(report, [], [], disabled_critics=["vlm"])
    assert 12 in off3.include
    # and everything back
    assert apply_overrides(off3, [], []).exclude == report.exclude


def test_tuning_snippet_is_a_pastable_spec_change():
    rows = [d for d in flag_impact(_sample()) if d["decides"]]
    snippet = tuning_snippet(rows)
    assert "scoring:" in snippet and "ignore_flags:" in snippet
    assert "- HUMAN_IN_WORKSPACE" in snippet and "12 → accept" in snippet
    # the weight hint appears only where muting alone does not recover the episode
    assert "weight: 0.0" in snippet and "duplication" in snippet
    assert tuning_snippet([]) == ""


def test_ignore_flags_removes_the_gate_and_the_review_cap():
    gated = CriticResult(
        id="duplication", kind="hard", weight=1.0, score=0.5, gate=True, gate_failed=True, flags=["LAGGY"]
    )
    cfg = ScoringConfig(review_flags=["HUMAN_IN_WORKSPACE"], ignore_flags=["HUMAN_IN_WORKSPACE"])
    good = CriticResult(id="smoothness", kind="hard", weight=1.0, score=0.95, flags=["HUMAN_IN_WORKSPACE"])
    s = aggregate(1, [good], [], cfg)
    assert s.verdict == "accept" and s.flags == [] and not s.reasons
    # a muted flag never reaches the report of a still-gated episode either
    s = aggregate(2, [gated, good], [], cfg)
    assert s.verdict == "reject" and s.flags == ["LAGGY"]
    assert mute_flags(["LAGGY", "HUMAN_IN_WORKSPACE"], cfg) == ["LAGGY"]


def test_ignore_flags_end_to_end_keeps_the_episode(synthetic_dataset, tmp_path):
    """The synthetic fixture has one episode whose gripper never closes (NOGRASP gate)."""
    spec = auto_spec(synthetic_dataset)
    spec.soft_critics.enabled = False
    base = run(synthetic_dataset, spec, RunOptions(out_dir=str(tmp_path / "a"), run_soft=False))
    assert 3 in base.exclude and "NOGRASP" in base.flag_counts

    spec.scoring.ignore_flags = ["NOGRASP"]
    muted = run(synthetic_dataset, spec, RunOptions(out_dir=str(tmp_path / "b"), run_soft=False))
    assert 3 not in muted.exclude
    assert "NOGRASP" not in muted.flag_counts
    assert all("NOGRASP" not in r.score.flags for r in muted.episodes)

    # the score of the critic that raised it is untouched: muting is not a score change
    def grasp_score(rep, ep):
        return next(c.score for c in rep.episodes[ep].hard if c.id == "grasp_cycles")

    assert grasp_score(base, 3) == grasp_score(muted, 3)
    # and the report says which findings were switched off
    assert "ignore_flags" in render_html_report(muted) and "NOGRASP" in render_html_report(muted)


def test_reports_contain_the_lists_the_reasons_and_the_off_switches():
    report = _sample()
    html = render_html_report(report, top_n=2)
    assert "Which episodes to filter" in html
    assert "include = [0, 1, 2" in html and "exclude = [13, 14]" in html
    # every filtered episode is explained, not only the two in the detail analysis
    assert "Why these 3 episodes were filtered" in html
    for ep in (12, 13, 14):
        assert f"<td><b>{ep}</b></td>" in html
    assert "Criteria you can switch off" in html and "ignore_flags" in html

    md = render_markdown(report)
    assert "- as a filter: `0-11`" in md
    assert "## Why these 3 episodes were filtered" in md
    assert "## Criteria you can switch off" in md and "`HUMAN_IN_WORKSPACE`" in md


def test_selection_json_is_the_machine_readable_answer():
    sel = build_selection(_sample())
    assert sel["ranges"] == {"accept": "0-11", "review": "12", "reject": "13-14"}
    assert sel["include_with_review"] == list(range(13))
    assert sel["reasons"]["13"]["cause"] == "gate"
    assert sel["reasons"]["13"]["blocking"] == ["LAGGY"]
    assert sel["reasons"]["12"]["why"].startswith("score 0.90 would accept")
    assert [d["flag"] for d in sel["switchable"]] == ["HUMAN_IN_WORKSPACE", "LAGGY"]
    json.dumps(sel)  # must stay serialisable


def test_episodes_cli(tmp_path):
    report = _sample()
    (tmp_path / "report.json").write_text(report.model_dump_json())
    run_cli = CliRunner().invoke
    out = run_cli(app, ["episodes", str(tmp_path), "--why", "--switchable"]).output
    assert "accept (12" in out and "0-11" in out and "reject (2" in out
    assert "ep 13 reject" in out and "decided by: LAGGY" in out
    assert "HUMAN_IN_WORKSPACE" in out and "12 → accept" in out

    assert run_cli(app, ["episodes", str(tmp_path), "-v", "accept", "-f", "ranges"]).output.strip() == "0-11"
    assert run_cli(app, ["episodes", str(tmp_path), "-v", "reject", "-f", "list"]).output.split() == [
        "13",
        "14",
    ]
    assert (
        run_cli(app, ["episodes", str(tmp_path), "-v", "accept+review", "-f", "ranges"]).output.strip()
        == "0-12"
    )
    assert (
        json.loads(run_cli(app, ["episodes", str(tmp_path), "-f", "json"]).output)["ranges"]["reject"]
        == "13-14"
    )
    assert run_cli(app, ["episodes", str(tmp_path), "-v", "nope"]).exit_code != 0
    assert run_cli(app, ["episodes", str(tmp_path), "-f", "nope"]).exit_code != 0
