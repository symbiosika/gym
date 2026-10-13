"""Which episodes to filter, why each one was filtered, and which criterion to switch off.

A run answers three questions that every report has to make explicit:

* **Which episode numbers do I feed to training, which do I drop?** -> :func:`selection_lists`
  returns accept / review / reject as episode numbers *and* in the compact ``0-12,14,16-21``
  form that a ``--episodes`` argument or a dataset filter wants.
* **Why was *this* episode filtered?** -> :func:`filtered_episodes` gives one row per
  non-accepted episode with the single decisive cause (a failed gate, a review flag, or the
  score alone), the evidence behind it and what to do about it - for *every* filtered
  episode, not just the worst few.
* **That criterion does not apply to my setup - can I switch it off?** -> :func:`flag_impact`
  replays the whole run with one flag muted and reports how many episodes would come back
  as ``accept``; :func:`tuning_snippet` prints the spec change that does it.

The impact numbers are a real replay of :func:`~lerobot_critics.scoring.aggregate` over the
stored critic results, not an estimate: muting a flag removes its gate and its review cap but
never changes a critic's score, so a flag that only *lowered a score* shows up here with
"would still not be accepted" and a pointer at the critic's weight instead.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from .ai_report import flag_meaning
from .scoring import REVIEW_CAP_PREFIX, EpisodeScore, aggregate
from .spec.models import CriticSpec

if TYPE_CHECKING:  # pragma: no cover
    from .critics.base import CriticResult
    from .runner import DatasetReport, EpisodeReport

VERDICT_MEANING = {
    "accept": "use for training",
    "review": "a person should look at it",
    "reject": "exclude from training",
}

# The same three verdicts read as the outcome of a policy rollout (spec purpose "evaluation").
VERDICT_MEANING_EVALUATION = {
    "accept": "the policy did the task (success)",
    "review": "undecided, a person should look at it",
    "reject": "the policy did not do the task (failure)",
}


def purpose_of(report: DatasetReport) -> str:
    """The purpose the run was judged with, from the spec the report carries."""
    return str((report.spec or {}).get("purpose") or "recording")


def verdict_meaning(purpose: str = "recording") -> dict[str, str]:
    return VERDICT_MEANING_EVALUATION if purpose == "evaluation" else VERDICT_MEANING


# What to do about a flag, in one imperative sentence. Flags without an entry get none.
FLAG_ACTION: dict[str, str] = {
    "LENGTH_MISMATCH": "re-export the episode; parquet and meta disagree about its length",
    "EMPTY": "drop the episode, it has no frames",
    "VIDEO_MISSING": "recover the video or drop the episode; the vision checks cannot see it",
    "VIDEO_FRAME_MISMATCH": "re-encode the video; frames and rows must line up for training",
    "NAN_VALUES": "fix the recorder; NaNs propagate into the normalisation statistics",
    "TIMESTAMP_GAPS": "check the recorder loop and disk throughput at record time",
    "TOO_SHORT": "check the protocol, or lower duration.min_s if such episodes are fine",
    "TOO_LONG": "trim the episode, or raise duration.max_s if such episodes are fine",
    "JERKY": "smooth the teleop input (lower gain, add filtering) or move more slowly",
    "ACTION_SPIKES": "check the leader device for dropouts; spikes teach impossible jumps",
    "HESITATION": "trim the pause or re-record; long stalls are dead training time",
    "TRACKERR": "check follower calibration, payload and gains - the robot did not follow the command",
    "INACTIVE_ARM_TRACKERR": "check the idle arm's calibration; it drifts away from its command",
    "LAGGY": "check the teleop link (USB / WiFi) and the recorder's loop rate",
    "CAMSTALL": "check camera bandwidth and USB hubs; stalled frames desynchronise vision and action",
    "STATE_FROZEN": "check the state feedback path; the follower reported no movement",
    "BLUR": "refocus the camera or shorten the exposure time",
    "OVEREXPOSED": "reduce lighting or camera exposure",
    "UNDEREXPOSED": "add light or raise camera exposure",
    "LIMIT_VIOLATION": "verify the limits in the spec, or the robot left its safe envelope",
    "SATURATED": "check for a clamp or a stuck sensor on that dimension",
    "NOGRASP": "drop the episode; without a grasp there is nothing to imitate",
    "CYCLE_COUNT": "check task.expected_cycles or the recording protocol",
    "MULTIGRASP": "keep it only if retries are desired behaviour",
    "REGRASP": "keep it only if re-adjusting is desired behaviour, otherwise re-record",
    "UNFINISHED_GRASP": "trim the tail or re-record the release; the hand stayed closed at the end",
    "TREMOR": "stabilise the input device (support the arm, lower sensitivity) or filter the command",
    "HOLD_JITTER": "give the operator a hold / clutch on the leader so still phases are really still",
    "ZERO_FRAMES": "remove the dropout frames and recompute meta/stats.json",
    "IDLE_ARM_DRIFT": "mask the idle arm out of the action space, or keep it still while recording",
    "ACTION_IS_STATE": "record the operator's command, not the readback; this action carries no lead",
    "STATS_RANGE_INFLATED": "recompute meta/stats.json after removing the dropout frames",
    "DEAD_ACTION_DIMS": "drop the constant dimensions from the action space",
    "LOW_DIVERSITY": "vary the object position between episodes",
    "VLM_TASK_FAILED": "watch the composite video; if the task really failed, exclude the episode",
    "VLM_MAJOR_ANOMALY": "watch the composite video at the reported timestamp",
    "HUMAN_IN_WORKSPACE": "keep hands out of the workspace while the robot moves, or trim the segment",
}

# What to do about a flag when the episodes are policy rollouts: the flag is the same finding,
# the consequence is not. What is not listed here keeps the general advice.
FLAG_ACTION_EVALUATION: dict[str, str] = {
    "VLM_TASK_FAILED": "watch the composite video; if the task really failed, the rollout is a failure",
    "VLM_MAJOR_ANOMALY": "watch the composite video at the reported time; an anomaly after the task was "
    "done does not undo the success",
    "HUMAN_IN_WORKSPACE": "a person intervened while the robot moved: the rollout is invalid, not a failure "
    "of the policy",
    "NOGRASP": "the policy never closed the hand: a failure, unless the task needs no grasp",
    "UNFINISHED_GRASP": "the hand was still closed at the end: check whether the object was placed",
    "CYCLE_COUNT": "the number of attempts differs from the plan; not a failure by itself",
    "MULTIGRASP": "several attempts; the outcome decides, not the count",
    "REGRASP": "the policy re-adjusted its grasp; the outcome decides",
    "CAMSTALL": "camera stalled during the rollout: an infrastructure fault, not charged to the policy",
    "LAGGY": "the command stream froze: an infrastructure fault, not charged to the policy",
    "STATE_FROZEN": "the state feedback froze: an infrastructure fault, not charged to the policy",
    "TRACKERR": "the robot did not follow the policy's command: a controller fault, not charged to the policy",
    "ACTION_SPIKES": "single-frame jumps in the policy's command; informational for a rollout",
    "ZERO_FRAMES": "all-zero command frames after the start-up delay: check the inference stack's output",
    "TOO_SHORT": "the rollout ended early; check whether it was cut or the policy stopped",
    "TOO_LONG": "the rollout ran long; a timeout is a failure only if the task was not done",
    "HESITATION": "a long still span; a failure only if the task was not done (timeout, no progress)",
    "JERKY": "informational for a rollout; the outcome decides",
}

# Flags that describe a signal an unused arm produces - the classic "this does not apply to me".
NOT_APPLICABLE_HINT: dict[str, str] = {
    "INACTIVE_ARM_TRACKERR": "raised for an arm that is not doing the task; irrelevant when that arm "
    "is unused - exclude it from tracking_error instead of muting the flag if it should not cost score",
    "IDLE_ARM_DRIFT": "raised for an arm that should idle; irrelevant when that arm is not part of "
    "the task, but its motion is still noise in the action space the policy learns",
    "DEAD_ACTION_DIMS": "constant action dimensions - expected when a whole arm is parked",
    "LOW_DIVERSITY": "one object position for the whole run; intended for a fixed-pose protocol",
}


def flag_action(flag: str, purpose: str = "recording") -> str:
    if purpose == "evaluation" and flag in FLAG_ACTION_EVALUATION:
        return FLAG_ACTION_EVALUATION[flag]
    if flag in FLAG_ACTION:
        return FLAG_ACTION[flag]
    if flag.endswith("_OUTLIER"):
        return "informational: this episode differs from the rest of the run, it is not wrong by itself"
    if flag.startswith("VLM_"):
        return "watch the composite video and decide whether the indicator is really unmet"
    return ""


# ------------------------------------------------------------------ episode lists
def compact_ranges(nums: Iterable[int]) -> str:
    """``[0,1,2,4,7,8] -> "0-2,4,7-8"`` - the form a ``--episodes`` filter takes."""
    out: list[str] = []
    start = prev = None
    for n in sorted(set(int(x) for x in nums)):
        if start is None:
            start = prev = n
            continue
        if n == prev + 1:
            prev = n
            continue
        out.append(str(start) if start == prev else f"{start}-{prev}")
        start = prev = n
    if start is not None:
        out.append(str(start) if start == prev else f"{start}-{prev}")
    return ",".join(out)


def selection_lists(report: DatasetReport) -> dict[str, dict[str, Any]]:
    """The three episode lists of a run, each as numbers, compact ranges and a count."""
    meaning = verdict_meaning(purpose_of(report))
    return {
        verdict: {
            "episodes": list(eps),
            "n": len(eps),
            "ranges": compact_ranges(eps),
            "meaning": meaning[verdict],
        }
        for verdict, eps in (
            ("accept", report.include),
            ("review", report.review),
            ("reject", report.exclude),
        )
    }


# ------------------------------------------------------------------ why an episode was filtered
def overrides_of(report: DatasetReport) -> tuple[set[str], set[str], set[str]]:
    """``(ignore, review, disabled)``: the findings a person downgraded after the run and the
    critics a person switched off for it."""
    ov = report.overrides or {}
    ignore = {str(f) for f in ov.get("ignore_flags", [])}
    review = {str(f) for f in ov.get("review_flags", [])} - ignore
    disabled = {str(c) for c in ov.get("disabled_critics", [])}
    return ignore, review, disabled


def critic_disabled(critic_id: str, disabled: set[str]) -> bool:
    """A critic is off when named itself or by its group: ``vlm`` switches off every ``vlm.*`` result."""
    return critic_id in disabled or any(critic_id.startswith(d + ".") for d in disabled)


def _spec(report: DatasetReport) -> CriticSpec:
    """The spec the verdicts are read with: the run's spec with the overrides folded in.

    A flag downgraded to *review* leaves every gate and the reject list and joins the review
    list, so it caps an episode at review instead of rejecting it. A flag downgraded to
    *ignore* is muted like ``scoring.ignore_flags``. A *disabled* critic has no weight, no
    gate and no gate flags: it does not apply to this dataset, whatever it measured. Without
    overrides this is the run's spec.
    """
    spec = CriticSpec.model_validate(report.spec)
    ignore, review, disabled = overrides_of(report)
    if not ignore and not review and not disabled:
        return spec
    gone = ignore | review
    scoring = spec.scoring.model_copy(
        update={
            "ignore_flags": sorted(set(spec.scoring.ignore_flags) | ignore),
            "review_flags": sorted((set(spec.scoring.review_flags) - ignore) | review),
            "reject_flags": sorted(set(spec.scoring.reject_flags) - gone),
        }
    )
    hard = [
        c.model_copy(
            update={"weight": 0.0, "gate": False, "gate_flags": []}
            if critic_disabled(c.id, disabled)
            else {"gate_flags": [f for f in c.gate_flags if f not in gone]}
        )
        for c in spec.hard_critics
    ]
    soft = spec.soft_critics.model_copy(
        update={
            "indicators": [
                i.model_copy(update={"weight": 0.0, "gate": False})
                if critic_disabled(f"vlm.{i.id}", disabled)
                else i
                for i in spec.soft_critics.indicators
            ]
        }
    )
    return spec.model_copy(update={"scoring": scoring, "hard_critics": hard, "soft_critics": soft})


def _cap_flags(score: EpisodeScore) -> list[str]:
    """Flags that capped an otherwise accepted episode at review (from the reason line)."""
    for r in score.reasons:
        if r.startswith(REVIEW_CAP_PREFIX):
            return [f.strip() for f in r[len(REVIEW_CAP_PREFIX) :].split(",") if f.strip()]
    return []


def blocking_flags(report: DatasetReport, r: EpisodeReport, spec: CriticSpec | None = None) -> list[str]:
    """The flags that actually decided this episode's verdict (gate, forced reject, review cap).

    Flags outside this list are findings the run recorded but did *not* filter on - muting
    them changes nothing about the verdict.
    """
    spec = spec or _spec(report)
    gate_flags = {c.id: set(c.gate_flags) for c in spec.hard_critics}
    out: list[str] = []
    for c in r.hard:
        if c.gate_failed:
            out += sorted(gate_flags.get(c.id, set()) & set(c.flags))
    out += sorted(set(spec.scoring.reject_flags) & set(r.score.flags))
    out += _cap_flags(r.score)
    return sorted(dict.fromkeys(out))


def episode_reason(report: DatasetReport, r: EpisodeReport, spec: CriticSpec | None = None) -> dict[str, Any]:
    """One row explaining a single episode's verdict.

    ``cause`` is the *one* thing that decided it - ``gate``, ``flag`` (a review/reject flag on
    an otherwise good score), ``score``, ``error`` or ``""`` for an accepted episode - and
    ``blocking`` names the flags behind a flag-driven verdict, i.e. exactly what you would
    have to switch off to get the episode back.
    """
    spec = spec or _spec(report)
    cfg = spec.scoring
    s = r.score
    blocking = blocking_flags(report, r, spec)
    disabled = overrides_of(report)[2]
    weakest = sorted(
        (
            c
            for c in r.hard + r.soft
            if c.score is not None and c.weight > 0 and not critic_disabled(c.id, disabled)
        ),
        key=lambda c: c.score or 0.0,
    )[:3]
    if s.verdict == "accept":
        cause, headline = "", ""
    elif r.error:
        cause = "error"
        headline = f"critic run failed: {r.error.splitlines()[0]}"
    elif s.gates_failed:
        cause = "gate"
        by = f" (flag {', '.join(blocking)})" if blocking else ""
        headline = f"gate failed: {', '.join(s.gates_failed)}{by}"
    elif blocking and s.total is not None and s.total >= cfg.accept_threshold:
        cause = "flag"
        headline = f"score {s.total:.2f} would accept, but flag {', '.join(blocking)} caps it at review"
    elif s.total is None:
        cause = "score"
        headline = "no score: no critic was applicable"
    else:
        cause = "score"
        thr = cfg.accept_threshold if s.verdict == "review" else cfg.review_threshold
        weak = ", ".join(f"{c.id} {c.score:.2f}" for c in weakest if (c.score or 1.0) < 1.0)
        headline = f"total {s.total:.2f} below {thr:g}" + (f" - weakest: {weak}" if weak else "")
    return {
        "episode": r.episode,
        "verdict": s.verdict,
        "total": s.total,
        "cause": cause,
        "headline": headline,
        "details": [d for d in s.reasons if not d.startswith(REVIEW_CAP_PREFIX)][:6],
        "flags": list(s.flags),
        "blocking": blocking,
        "gates": list(s.gates_failed),
        "actions": [a for a in (flag_action(f, purpose_of(report)) for f in blocking) if a],
    }


def filtered_episodes(report: DatasetReport) -> list[dict[str, Any]]:
    """Why every non-accepted episode was filtered - rejects first, then reviews."""
    spec = _spec(report)
    order = {"reject": 0, "review": 1, "accept": 2}
    rows = [episode_reason(report, r, spec) for r in report.episodes if r.score.verdict != "accept"]
    return sorted(
        rows, key=lambda d: (order.get(d["verdict"], 3), d["total"] if d["total"] is not None else -1)
    )


# ------------------------------------------------------------------ switching a criterion off
def _replay(
    r: EpisodeReport, spec: CriticSpec, ignore: set[str], disabled: set[str] | None = None
) -> EpisodeScore:
    """Re-aggregate one episode as if ``ignore`` had never been raised.

    ``spec`` is the effective spec (:func:`_spec`), so a gate is re-decided against the gate
    flags that are left after the overrides: a flag downgraded to review no longer fires it.
    A result of a ``disabled`` critic enters the aggregation with no weight, no gate and no
    flags: as if the critic had not run. Its score stays on the record for the reader.
    """
    ignore = set(ignore) | set(spec.scoring.ignore_flags)
    disabled = disabled or set()
    gate_flags = {c.id: set(c.gate_flags) for c in spec.hard_critics}
    gate_score = {c.id: (c.gate, c.gate_below) for c in spec.hard_critics}

    def redo(c: CriticResult, hard: bool) -> CriticResult:
        if critic_disabled(c.id, disabled):
            return c.model_copy(
                update={"weight": 0.0, "gate": False, "gate_failed": False, "flags": [], "evidence": []}
            )
        keep = [f for f in c.flags if f not in ignore]
        if not hard:
            return c if keep == c.flags else c.model_copy(update={"flags": keep})
        gate, below = gate_score.get(c.id, (False, 0.0))
        failed = bool(gate and c.score is not None and c.score < below) or bool(
            gate_flags.get(c.id, set()) & set(keep)
        )
        if keep == c.flags and failed == c.gate_failed:
            return c
        return c.model_copy(update={"flags": keep, "gate_failed": failed})

    cfg = spec.scoring.model_copy(update={"ignore_flags": sorted(set(spec.scoring.ignore_flags) | ignore)})
    score = aggregate(r.episode, [redo(c, True) for c in r.hard], [redo(c, False) for c in r.soft], cfg)
    if r.error:
        score.verdict = "review"
    return score


def verdicts_with_ignored(report: DatasetReport, ignore: Iterable[str]) -> dict[int, EpisodeScore]:
    """The verdict of every episode if the given flags were in ``scoring.ignore_flags``."""
    spec = _spec(report)
    ig = set(ignore)
    disabled = overrides_of(report)[2]
    return {r.episode: _replay(r, spec, ig, disabled) for r in report.episodes}


def apply_overrides(
    report: DatasetReport,
    ignore_flags: Iterable[str],
    review_flags: Iterable[str],
    disabled_critics: Iterable[str] = (),
) -> DatasetReport:
    """The run read with downgraded findings: the verdicts replayed, the critic results untouched.

    ``review_flags`` cap an episode at review instead of rejecting it (the finding stays on the
    episode as a warning), ``ignore_flags`` are muted as if never raised, ``disabled_critics``
    (critic ids such as ``tracking_error``, or ``vlm`` for the whole model) do not count at
    all: no weight, no gate, no flags. The overrides replace the previous ones, so passing
    empty lists restores the run as it was scored. Counts, the episode lists and the flag
    counts are recomputed; everything else in the report (stats, session profile, the
    critics' evidence) is what the run found.
    """
    ignore = {str(f) for f in ignore_flags}
    review = {str(f) for f in review_flags} - ignore
    disabled = {str(c) for c in disabled_critics}
    out = report.model_copy(
        deep=True,
        update={
            "overrides": {
                "ignore_flags": sorted(ignore),
                "review_flags": sorted(review),
                "disabled_critics": sorted(disabled),
            }
        },
    )
    spec = _spec(out)
    for r in out.episodes:
        r.score = _replay(r, spec, set(), disabled)
        if r.error:
            r.score.reasons.insert(0, f"critic run failed: {r.error.splitlines()[0]}")
    counts = {"accept": 0, "review": 0, "reject": 0}
    flag_counts: dict[str, int] = {}
    for r in out.episodes:
        counts[r.score.verdict] += 1
        for f in r.score.flags:
            flag_counts[f] = flag_counts.get(f, 0) + 1
    out.counts = counts
    out.include = [r.episode for r in out.episodes if r.score.verdict == "accept"]
    out.review = [r.episode for r in out.episodes if r.score.verdict == "review"]
    out.exclude = [r.episode for r in out.episodes if r.score.verdict == "reject"]
    out.flag_counts = dict(sorted(flag_counts.items(), key=lambda kv: -kv[1]))
    return out


def flag_impact(report: DatasetReport) -> list[dict[str, Any]]:
    """Per flag of the run: what it costs and what switching it off would give back.

    ``would_accept`` are the episodes that come back as ``accept`` when the flag is muted,
    ``would_improve`` every episode whose verdict gets better (a rejected episode that only
    reaches ``review`` because its score is low as well shows up here, not in
    ``would_accept``). Both empty means the flag did not filter anything by itself.
    ``critics`` names who raised it, so that a score penalty can be addressed at the critic
    (weight, params) instead.
    """
    spec = _spec(report)
    cfg = spec.scoring
    gate_flags = {f for c in spec.hard_critics for f in c.gate_flags}
    rank = {"reject": 0, "review": 1, "accept": 2}
    by_ep = {r.episode: r.score.verdict for r in report.episodes}
    # A replay is only trustworthy where replaying with nothing muted reproduces the verdict the
    # run recorded; a report written by another version (or with dropped critic results) does not
    # get to claim an improvement.
    base = verdicts_with_ignored(report, set())
    reproducible = {e for e, s in base.items() if s.verdict == by_ep[e]}
    rows: list[dict[str, Any]] = []
    for flag, count in report.flag_counts.items():
        eps = [r.episode for r in report.episodes if flag in r.score.flags]
        critics = sorted({c.id for r in report.episodes for c in r.hard + r.soft if flag in c.flags})
        blocked = [
            r.episode
            for r in report.episodes
            if r.score.verdict != "accept" and flag in blocking_flags(report, r, spec)
        ]
        after = verdicts_with_ignored(report, {flag}) if blocked else {}
        improved = {
            e: after[e].verdict
            for e in blocked
            if e in after and e in reproducible and rank[after[e].verdict] > rank[by_ep[e]]
        }
        would = [e for e, v in improved.items() if v == "accept"]
        if flag in gate_flags:
            effect = "rejects the episode (gate)"
        elif flag in cfg.reject_flags:
            effect = "rejects the episode"
        elif flag in cfg.review_flags:
            effect = "caps the episode at review"
        else:
            effect = "informational (no effect on the verdict)"
        rows.append(
            {
                "flag": flag,
                "n": count,
                "episodes": eps,
                "critics": critics,
                "effect": effect,
                "decides": blocked,
                "would_accept": would,
                "would_improve": improved,
                "meaning": flag_meaning(flag),
                "action": flag_action(flag),
                "hint": NOT_APPLICABLE_HINT.get(flag, ""),
            }
        )
    return sorted(
        rows,
        key=lambda d: (
            -len(d["would_accept"]),
            -len(d["would_improve"]),
            -len(d["decides"]),
            -d["n"],
            d["flag"],
        ),
    )


def impact_text(row: dict[str, Any]) -> str:
    """``"12-14 -> accept, 17 -> review"`` - what muting this finding gives back."""
    by_verdict: dict[str, list[int]] = {}
    for ep, verdict in row["would_improve"].items():
        by_verdict.setdefault(verdict, []).append(ep)
    if not by_verdict:
        return ""
    return ", ".join(
        f"{compact_ranges(eps)} → {verdict}"
        for verdict, eps in sorted(by_verdict.items(), key=lambda kv: kv[0] != "accept")
    )


def tuning_snippet(rows: Iterable[dict[str, Any]]) -> str:
    """A spec snippet that switches the given findings off, as YAML to paste into the spec."""
    rows = [r for r in rows if r.get("flag")]
    if not rows:
        return ""
    lines = ["scoring:", "  ignore_flags:"]
    for r in rows:
        gain = impact_text(r)
        note = f"episodes {gain}" if gain else "no verdict change, informational only"
        lines.append(f"    - {r['flag']}  # {note}")
    # The weight hint only helps where muting alone is not enough (the score filters the episode
    # too) or where the finding is one of the "does not apply to my setup" kind.
    score_bound = [r for r in rows if not r["would_accept"] or r["hint"]]
    critics = sorted({c for r in score_bound for c in r["critics"] if not c.startswith("vlm.")})
    if critics:
        lines += [
            "",
            "# ignore_flags removes the verdict effect, not the score the critic gave.",
            "# To take the score penalty out as well, lower the weight of (or disable) the critic:",
            "hard_critics:",
        ]
        for c in critics:
            lines.append(f"  - id: {c}")
            lines.append("    weight: 0.0        # or: enabled: false")
    return "\n".join(lines)
