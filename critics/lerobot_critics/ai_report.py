"""AI-readable Markdown export of a critic run ("copy as Markdown").

``report.md`` is written for a person skimming results. This module renders the same
:class:`~lerobot_critics.runner.DatasetReport` as a **self-contained** Markdown document
meant to be pasted into an LLM chat or handed to an agent: it explains what the numbers
mean, states the task and every check that was run (weights, gates, thresholds), carries
a glossary of every flag that occurs, and lists per episode the scores, flags, metrics,
evidence and the VLM judge's attempts and anomalies in plain Markdown tables. A model
needs no other context to answer "why was episode 30 rejected?" or "which episodes
should I drop before training?".

    lerobot-critics markdown critic_out/ | pbcopy          # CLI
    GET /jobs/{id}/markdown?detail=full                    # REST
    UI: "Copy as Markdown" on a finished job

Three detail levels: ``summary`` (run, task, checks, verdicts, score table),
``flagged`` (+ per-episode details for review/reject episodes), ``full`` (+ details for
every episode). ``report_ai.md`` (``full``) is written next to ``report.md`` on every run.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from . import __version__

if TYPE_CHECKING:  # pragma: no cover
    from .critics.base import CriticResult
    from .runner import DatasetReport, EpisodeReport

Detail = Literal["summary", "flagged", "full"]
DETAIL_LEVELS: tuple[str, ...] = ("summary", "flagged", "full")

# What each flag means, in one sentence. Unknown flags fall back to a generic rule below.
FLAG_GLOSSARY: dict[str, str] = {
    # integrity
    "LENGTH_MISMATCH": "parquet row count differs from the episode length declared in meta",
    "EMPTY": "episode has no frames",
    "FRAME_INDEX_GAPS": "frame_index is not contiguous",
    "TIMESTAMPS_NOT_MONOTONIC": "timestamps go backwards",
    "TIMESTAMP_GAPS": "timestamps have gaps larger than a frame at the nominal fps",
    "NAN_VALUES": "NaN or inf in numeric features",
    "VIDEO_MISSING": "a camera video file is missing or unreadable",
    "VIDEO_FRAME_MISMATCH": "video frame count differs from the parquet length",
    # duration
    "TOO_SHORT": "episode shorter than duration.min_s",
    "TOO_LONG": "episode longer than duration.max_s",
    # smoothness
    "JERKY": "high log-dimensionless-jerk or high-frequency energy (tremor) in the motion",
    "ACTION_SPIKES": "physically implausible single-frame command jumps",
    "HESITATION": "long still span in the middle of the episode",
    # tracking error
    "TRACKERR": "follower deviates from the commanded pose beyond the bad threshold (active arm)",
    "INACTIVE_ARM_TRACKERR": "an arm that is not doing the task deviates from its command",
    # duplication
    "CAMSTALL": "camera frames repeated while the robot moved, or all cameras frozen at once",
    "LAGGY": "command (action) vector frozen for many frames or a long run",
    "STATE_FROZEN": "observation.state identical over many consecutive frames",
    # image quality
    "OVEREXPOSED": "camera too bright or many blown-out pixels",
    "UNDEREXPOSED": "camera too dark or many black pixels",
    "BLUR": "low Laplacian sharpness (defocus / motion blur)",
    "SIZE_MISMATCH": "decoded frame size differs from meta/info.json",
    # sensor limits
    "LIMIT_VIOLATION": "a configured feature limit was exceeded",
    "DEAD_ZONE": "a value rested inside a configured dead zone",
    "SATURATED": "a dimension pinned at its extreme for a long run (clamp or stuck sensor)",
    # grasp cycles
    "NOGRASP": "the gripper/hand never closed on anything",
    "CYCLE_COUNT": "number of grasp cycles differs from task.expected_cycles",
    "MULTIGRASP": "several grasp cycles where one was expected (retry?)",
    "REGRASP": "the gripper re-closed within a second of releasing (re-adjust)",
    "UNFINISHED_GRASP": "the gripper was still closed at the end of the episode without a release before",
    # tremor
    "TREMOR": "the command carries strong 6-14 Hz velocity energy (hand tremor of the input device or a vibrating robot)",
    "HOLD_JITTER": "the command keeps moving (RMS speed above threshold) inside phases where the hand should be still",
    # normalization
    "ZERO_FRAMES": "all-zero dropout frame(s) in a pose/joint feature; they corrupt min/max normalisation statistics",
    "IDLE_ARM_DRIFT": "an arm that is not doing the task (robot.active_arms) travelled far; its motion is noise in the action space",
    "ACTION_IS_STATE": "an action feature never differs from its state: a readback, not an operator command",
    # dataset-level (run summary, not per episode)
    "STATS_RANGE_INFLATED": "meta/stats.json min/max is wider than the real data (dropout frames); min_max normalisation loses resolution",
    "DEAD_ACTION_DIMS": "action dimensions constant across the whole run; they carry no information",
    "LOW_DIVERSITY": "the object was grasped at practically the same position in every episode; the policy cannot learn to correct",
    # VLM
    "VLM_TASK_FAILED": "the VLM judged the task as not accomplished",
    "VLM_MAJOR_ANOMALY": "the VLM reported at least one anomaly with severity 'major'",
    "HUMAN_IN_WORKSPACE": "the VLM saw a person or hand in the workspace while the robot acted",
}


def flag_meaning(flag: str) -> str:
    if flag in FLAG_GLOSSARY:
        return FLAG_GLOSSARY[flag]
    if flag.endswith("_OUTLIER"):
        return (
            "dataset-relative outlier (robust z-score of the metric vs. all episodes of this run); "
            "informational, does not change the score"
        )
    if flag.startswith("VLM_"):
        return f"VLM indicator '{flag[4:].lower()}' scored below 0.5"
    return "(no description)"


# ------------------------------------------------------------------ small helpers
def _cell(x: Any) -> str:
    """One Markdown table cell: pipes escaped, newlines flattened, None as a dash."""
    if x is None:
        return "–"
    s = str(x).replace("\r", " ").replace("\n", " ").replace("|", "\\|").strip()
    return s or "–"


def _num(v: Any, digits: int = 2) -> str:
    if v is None:
        return "–"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:  # NaN
            return "–"
        if v.is_integer() and abs(v) < 1e15:
            return str(int(v))
        if abs(v) >= 100:
            s = f"{v:.1f}"
        elif abs(v) >= 1:
            s = f"{v:.{digits}f}"
        else:
            s = f"{v:.3g}"
        return s.rstrip("0").rstrip(".") if "." in s and "e" not in s else s
    return _cell(v)


def _score(x: float | None) -> str:
    return "–" if x is None else f"{x:.2f}"


def _ep_list(eps: list[int]) -> str:
    return ", ".join(str(e) for e in eps) if eps else "–"


def _table(head: list[str], rows: list[list[Any]]) -> list[str]:
    out = ["| " + " | ".join(_cell(h) for h in head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(_cell(c) for c in row) + " |" for row in rows]
    return out


def _kv_metrics(metrics: dict[str, Any], skip: set[str] | None = None) -> str:
    """Scalars (and short scalar lists) of a metrics dict as ``key=value`` pairs."""
    parts = []
    for k, v in metrics.items():
        if (skip and k in skip) or k.startswith("_"):
            continue
        if v is None:
            continue
        if isinstance(v, (bool, int, float)):
            parts.append(f"{k}={_num(v, 3)}")
        elif isinstance(v, str):
            if len(v) <= 60:
                parts.append(f"{k}={v}")
        elif isinstance(v, list) and len(v) <= 12 and all(isinstance(x, (int, float, type(None))) for x in v):
            parts.append(f"{k}=[{', '.join(_num(x, 2) for x in v)}]")
        elif isinstance(v, dict) and len(v) <= 12 and all(isinstance(x, (int, float)) for x in v.values()):
            parts.append(f"{k}={{{', '.join(f'{kk}: {_num(x, 3)}' for kk, x in v.items())}}}")
    return ", ".join(parts)


def _ordered(report: DatasetReport, episodes: list[int] | None) -> list[EpisodeReport]:
    """Worst first; optionally restricted to a subset."""
    eps = report.episodes if episodes is None else [e for e in report.episodes if e.episode in set(episodes)]
    return sorted(eps, key=lambda r: (r.score.total if r.score.total is not None else -1.0, r.episode))


def _critic_ids(report: DatasetReport) -> tuple[list[str], list[str]]:
    hard: list[str] = []
    soft: list[str] = []
    for r in report.episodes:
        for h in r.hard:
            if h.id not in hard:
                hard.append(h.id)
        for s in r.soft:
            if s.weight > 0 and s.id not in soft:
                soft.append(s.id)
    return hard, soft


def _spec(report: DatasetReport) -> dict[str, Any]:
    return report.spec if isinstance(report.spec, dict) else {}


def _gate_rule(cfg: dict[str, Any]) -> str:
    rules = []
    if cfg.get("gate"):
        rules.append(f"score < {_num(cfg.get('gate_below', 0.2))}")
    if cfg.get("gate_flags"):
        rules.append("flag " + " / ".join(cfg["gate_flags"]))
    return " or ".join(rules) if rules else "–"


def summary_lines(summ: dict, indent: str = "") -> list[str]:
    """Render a critic's dataset summary dict as Markdown bullets (nested dicts one level deep)."""
    out: list[str] = []
    for k, v in summ.items():
        if k == "flags":
            continue
        if isinstance(v, dict):
            if v and all(isinstance(x, dict) for x in v.values()):
                out.append(f"{indent}- **{k}**:")
                for kk, vv in v.items():
                    inner = ", ".join(f"{a}={_fmt_val(b)}" for a, b in vv.items())
                    out.append(f"{indent}  - `{kk}`: {inner}")
            else:
                inner = ", ".join(f"{kk}={_fmt_val(vv)}" for kk, vv in v.items())
                out.append(f"{indent}- **{k}**: {inner}")
        else:
            out.append(f"{indent}- **{k}**: {_fmt_val(v)}")
    return out


def _fmt_val(v) -> str:
    if isinstance(v, float):
        return f"{v:.3g}" if abs(v) < 100 else f"{v:.1f}"
    if isinstance(v, list):
        return "[" + ", ".join(_fmt_val(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ", ".join(f"{k}: {_fmt_val(x)}" for k, x in v.items()) + "}"
    return str(v)


def session_profile_lines(report: DatasetReport, title: str = "## Recording session profile") -> list[str]:
    """The session indicators (latency, tremor, grasp behaviour, diversity, hygiene) as Markdown."""
    prof = getattr(report, "session_profile", None) or {}
    if not prof.get("indicators"):
        try:
            from .session_profile import build_session_profile

            prof = build_session_profile(report)
        except Exception:  # noqa: BLE001
            return []
    if not prof.get("indicators"):
        return []
    from .session_profile import indicators_by_group

    L = [title, ""]
    L.append(
        "Physical properties of the recording session, aggregated over the evaluated episodes (median unless "
        "stated; thresholds are the spec's critic parameters). They say what to change at the rig, the teleop "
        "and the protocol before the next recording day."
    )
    L.append("")
    if prof.get("headline"):
        L.append(f"**{prof['headline']}**")
        L.append("")
    for g, items in indicators_by_group(prof):
        if not items:
            continue
        L.append(f"### {g['title']}")
        L.append("")
        L.append(f"_{g['intro']}_")
        L.append("")
        rows = []
        for i in items:
            spread = ""
            if i.get("n", 0) > 1 and i.get("low") is not None:
                spread = f"{_num(i['low'], 1)} – {_num(i['high'], 1)}"
            thr = ""
            if (
                i.get("good") is not None
                and i.get("bad") is not None
                and i.get("better") in ("lower", "higher")
            ):
                rel, rel_b = ("≤", "≥") if i["better"] == "lower" else ("≥", "≤")
                thr = f"good {rel} {_num(i['good'], 2)}, bad {rel_b} {_num(i['bad'], 2)}"
            extra = i.get("display_extra") or ""
            rows.append(
                [
                    i["label"],
                    f"**{i.get('display', '–')}** {i.get('unit', '')}".strip(),
                    spread or "–",
                    i.get("status", "info"),
                    thr or "–",
                    (i.get("so_what") or i.get("what") or "") + (f" ({extra})" if extra else ""),
                    i.get("action") or "–",
                ]
            )
        L += _table(
            ["indicator", "value", "min – max", "status", "thresholds", "what it means", "what to do"], rows
        )
        L.append("")
    cams = prof.get("cameras") or []
    if cams:
        L.append("### Cameras (median over the run)")
        L.append("")
        L += _table(
            [
                "camera",
                "brightness 0–255",
                "blown-out px",
                "black px",
                "sharpness (Laplacian var)",
                "repeated frames",
            ],
            [
                [
                    f"`{c['short']}`",
                    _num(c.get("brightness"), 0),
                    f"{_num(100 * c['clip_high'], 1)} %" if c.get("clip_high") is not None else "–",
                    f"{_num(100 * c['clip_low'], 1)} %" if c.get("clip_low") is not None else "–",
                    _num(c.get("sharpness_p10"), 0),
                    f"{_num(100 * c['dup_rate'], 0)} %" if c.get("dup_rate") is not None else "–",
                ]
                for c in cams
            ],
        )
        L.append("")
    return L


def metric_glossary_lines(
    report: DatasetReport, title: str = "## Metric glossary", only: set[str] | None = None
) -> list[str]:
    """What and how every metric that occurs in this run is measured (one table per critic).

    ``only`` restricts the glossary to the given ``critic.key`` entries (one episode's metrics).
    """
    docs = getattr(report, "metric_docs", None) or {}
    if only is not None:
        docs = {k: v for k, v in docs.items() if k in only}
    if not docs:
        return []
    L = [title, ""]
    L.append(
        "Every metric the critics emitted in this run, what it measures and how it is computed. "
        "Keys ending in `.<feature>` / `.<camera>` exist once per arm feature or camera. "
        "`better`: lower / higher = which direction is good, target = a specific value is expected, info = descriptive."
    )
    L.append("")
    by_critic: dict[str, list[dict]] = {}
    seen: set[tuple[str, str]] = set()
    for _full, d in docs.items():
        base = d["key"] if not d.get("feature") else d["key"][: -len(d["feature"]) - 1] + ".<feature>"
        if (d["critic"], base) in seen:
            continue
        seen.add((d["critic"], base))
        by_critic.setdefault(d["critic"], []).append({**d, "shown": base})
    for cid, items in by_critic.items():
        L.append(f"### {cid}")
        L.append("")
        L.append("| metric | unit | better | what | how |")
        L.append("|---|---|---|---|---|")
        for d in items:
            L.append(
                f"| `{d['shown']}` | {d['unit']} | {d['better']} | {_md_cell(d['what'])} | {_md_cell(d['how'])} |"
            )
        L.append("")
    flags = sorted({f for r in report.episodes for f in r.score.flags} | set(report.dataset_flags))
    if flags:
        L.append("### Flags")
        L.append("")
        L.append("| flag | meaning |")
        L.append("|---|---|")
        for f in flags:
            L.append(f"| `{f}` | {_md_cell(flag_meaning(f))} |")
        L.append("")
    return L


def _md_cell(s: str) -> str:
    return str(s).replace("|", "\\|").replace("\n", " ")


# ------------------------------------------------------------------ sections
def _sec_header(report: DatasetReport, L: list[str]) -> None:
    from .selection import purpose_of  # selection imports this module

    L.append(f"# lerobot-critics report: {report.dataset_name} · spec {report.spec_name}")
    L.append("")
    L.append(
        "> Machine-readable summary of an episode-quality run over a LeRobot dataset, produced by "
        f"lerobot-critics {__version__}. Every critic scores an episode in [0, 1] (1 = good). "
        "`hard` critics are deterministic checks on the recorded signals and video; `soft` critics are "
        "task-success indicators judged by a vision-language model (VLM) from the episode video. "
        "`total` is the weighted mean of the hard and soft group scores. Verdicts: "
        + (
            "**accept** (the policy did the task), **review** (undecided, a person should look), **reject** "
            "(the policy failed the task); the episodes are rollouts of a trained policy. "
            if purpose_of(report) == "evaluation"
            else "**accept** (use for training), **review** (a person should look), **reject** (exclude). "
        )
        + "A *gate* rejects an episode "
        "regardless of its score; *review flags* cap an otherwise accepted episode at review; "
        "`*_OUTLIER` flags are informational. Evidence strings are the critics' own explanations."
    )
    L.append("")


def _sec_run(report: DatasetReport, L: list[str]) -> None:
    t = report.timing_s or {}
    st = report.dataset_stats or {}
    spec = _spec(report)
    vlm = (spec.get("soft_critics") or {}).get("vlm") or {}
    soft_ran = any(s.id.startswith("vlm.") for r in report.episodes for s in r.soft)
    if soft_ran:
        vlm_line = f"{vlm.get('provider', '?')} · {vlm.get('model', '?')} · mode {vlm.get('mode', '?')}"
        if st.get("vlm_total_tokens"):
            vlm_line += f" · {int(st['vlm_total_tokens'])} tokens total"
    else:
        vlm_line = "not run (hard critics only)"
    rows = [
        ["dataset", report.dataset],
        ["robot", report.robot_type or "–"],
        ["fps", _num(report.fps)],
        ["cameras", ", ".join(report.cameras) if report.cameras else "–"],
        ["episodes evaluated", report.n_episodes],
        ["created (UTC)", report.created_at],
        [
            "runtime",
            f"{t.get('total_s', 0):.0f} s (hard {t.get('hard_s', 0):.0f} s, VLM {t.get('soft_s', 0):.0f} s)",
        ],
        ["VLM judge", vlm_line],
    ]
    L.append("## Run")
    L.append("")
    L += _table(["field", "value"], rows)
    L.append("")


def _per_episode_tasks(report: DatasetReport) -> list[str]:
    """The distinct instructions the episodes were judged against, or [] if one static one was.

    Mirrors :func:`lerobot_critics.critics.soft.prompts.effective_instruction`: under the default
    ``per_episode: auto`` the dataset's task wins only when the dataset records more than one.
    """
    mode = ((_spec(report).get("task") or {}).get("per_episode")) or "auto"
    if mode == "never":
        return []
    tasks = sorted({e.task for e in report.episodes if e.task})
    if mode == "auto" and len(tasks) < 2:
        return []
    return tasks


def _sec_task(report: DatasetReport, L: list[str]) -> None:
    spec = _spec(report)
    task = spec.get("task") or {}
    robot = spec.get("robot") or {}
    L.append("## Task")
    L.append("")
    # A dataset may vary the prompt per episode (scripted eval rollouts do); the spec instruction is
    # then only a fallback, and quoting it alone would misdescribe what every episode was judged on.
    per_ep = _per_episode_tasks(report)
    if per_ep:
        L.append(f"- **Instruction**: per episode, from the dataset ({len(per_ep)} distinct, below)")
        L.append(f"- **Spec fallback**: {task.get('instruction') or '–'}")
    else:
        L.append(f"- **Instruction**: {task.get('instruction') or '–'}")
    if task.get("scene"):
        L.append(f"- **Scene**: {task['scene']}")
    L.append(
        f"- **Expected cycles per episode**: {task.get('expected_cycles') if task.get('expected_cycles') is not None else 'unknown / single'}"
    )
    if task.get("notes"):
        L.append(f"- **Notes**: {task['notes']}")
    if robot.get("active_arms"):
        L.append(f"- **Active arms**: {', '.join(robot['active_arms'])}")
    if task.get("objects"):
        L.append("")
        L += _table(
            ["object", "role", "description"],
            [[o.get("name"), o.get("role"), o.get("description")] for o in task["objects"]],
        )
    if per_ep:
        L.append("")
        L += _table(
            ["instruction", "episodes"],
            [[t, ", ".join(str(e.episode) for e in report.episodes if e.task == t)] for t in per_ep],
        )
    L.append("")


def _sec_checks(report: DatasetReport, L: list[str]) -> None:
    spec = _spec(report)
    hard_ids, soft_ids = _critic_ids(report)
    try:
        from .critics.registry import list_hard_critics

        desc = {c["id"]: c["description"] for c in list_hard_critics()}
    except Exception:  # noqa: BLE001 - descriptions are a nicety
        desc = {}
    L.append("## Checks that were run")
    L.append("")
    hard_cfg = {c.get("id"): c for c in spec.get("hard_critics") or []}
    if hard_ids:
        L.append("### Hard critics (deterministic)")
        L.append("")
        rows = []
        for cid in hard_ids:
            cfg = hard_cfg.get(cid, {})
            params = cfg.get("params") or {}
            rows.append(
                [
                    f"`{cid}`",
                    _num(cfg.get("weight", 1.0)),
                    _gate_rule(cfg),
                    _kv_metrics(params) if params else "defaults",
                    desc.get(cid, ""),
                ]
            )
        L += _table(["critic", "weight", "gate (rejects when)", "parameters", "what it measures"], rows)
        L.append("")
    soft = spec.get("soft_critics") or {}
    inds = {f"vlm.{i.get('id')}": i for i in soft.get("indicators") or []}
    if soft_ids:
        L.append("### Soft critics (VLM success indicators)")
        L.append("")
        rows = []
        for sid in soft_ids:
            i = inds.get(sid, {})
            gate = f"score < {_num(i.get('gate_below', 0.3))}" if i.get("gate") else "–"
            rows.append(
                [
                    f"`{sid}`",
                    _num(i.get("weight", 1.0)),
                    gate,
                    i.get("description", ""),
                    i.get("rubric") or "–",
                ]
            )
        L += _table(["indicator", "weight", "gate (rejects when)", "description", "rubric"], rows)
        L.append("")
        L.append(
            "`vlm.summary` (weight 0) carries the VLM's overall verdict: task_success, the list of attempts "
            "(grasp/release times, placed correctly?) and anomalies with severity; it raises "
            "`VLM_TASK_FAILED`, `VLM_MAJOR_ANOMALY`, `HUMAN_IN_WORKSPACE`."
        )
        L.append("")
    sc = spec.get("scoring") or {}
    L.append("### Scoring rules")
    L.append("")
    L.append(
        f"- `hard_score` = weighted mean of the hard critics; `soft_score` = weighted mean of the soft "
        f"indicators; `total` = weighted mean of both groups (hard weight {_num(sc.get('hard_weight', 1.0))}, "
        f"soft weight {_num(sc.get('soft_weight', 1.0))}). A critic with no data (score `–`) is left out of the mean."
    )
    L.append(
        f"- Verdict: **reject** if any gate fired{' or a flag in ' + ', '.join(f'`{f}`' for f in sc['reject_flags']) if sc.get('reject_flags') else ''}; "
        f"else **accept** if total ≥ {_num(sc.get('accept_threshold', 0.75))}, "
        f"**review** if total ≥ {_num(sc.get('review_threshold', 0.55))}, otherwise **reject**."
    )
    if sc.get("review_flags"):
        L.append(
            "- Review flags (cap an accepted episode at review): "
            + ", ".join(f"`{f}`" for f in sc["review_flags"])
        )
    if sc.get("relative_flags", True):
        L.append(
            f"- Dataset-relative `*_OUTLIER` flags: robust z-score (median/MAD) > {_num(sc.get('z_cut', 3.0))} "
            "against the other episodes of this run; informational only."
        )
    L.append("")


def _sec_summary(report: DatasetReport, L: list[str]) -> None:
    from .selection import purpose_of, verdict_meaning  # selection imports this module

    labels = (
        verdict_meaning("evaluation")
        if purpose_of(report) == "evaluation"
        else {"accept": "include in training", "review": "look at these", "reject": "exclude"}
    )
    c = report.counts or {}
    L.append("## Result")
    L.append("")
    L.append(
        f"**{c.get('accept', 0)} accept · {c.get('review', 0)} review · {c.get('reject', 0)} reject** "
        f"of {report.n_episodes} episodes."
    )
    L.append("")
    L += _table(
        ["verdict", "count", "episodes"],
        [
            [f"accept ({labels['accept']})", c.get("accept", 0), _ep_list(report.include)],
            [f"review ({labels['review']})", c.get("review", 0), _ep_list(report.review)],
            [f"reject ({labels['reject']})", c.get("reject", 0), _ep_list(report.exclude)],
        ],
    )
    L.append("")
    if report.flag_counts:
        L.append("### Flags raised in this run")
        L.append("")
        ep_by_flag: dict[str, list[int]] = {}
        for r in report.episodes:
            for f in r.score.flags:
                ep_by_flag.setdefault(f, []).append(r.episode)
        L += _table(
            ["flag", "episodes", "which", "meaning"],
            [
                [f"`{f}`", n, _ep_list(ep_by_flag.get(f, [])), flag_meaning(f)]
                for f, n in report.flag_counts.items()
            ],
        )
        L.append("")
    L += session_profile_lines(report, "### Recording session profile")
    _sec_dataset_findings(report, L)
    _sec_dataset_stats(report, L)


def _sec_dataset_findings(report: DatasetReport, L: list[str]) -> None:
    """Run-level findings from HardCritic.summarize(): flags with explanation + summary dicts."""
    flags = getattr(report, "dataset_flags", None) or {}
    summaries = getattr(report, "dataset_summaries", None) or {}
    if not flags and not summaries:
        return
    L.append("### Dataset-level findings")
    L.append("")
    L.append(
        "Properties of the recording session as a whole, not of a single episode: spatial diversity of the "
        "demonstrations, normalisation statistics, action-space hygiene. They do not change any verdict."
    )
    L.append("")
    if flags:
        L += _table(["flag", "finding"], [[f"`{f}`", why] for f, why in flags.items()])
        L.append("")
    for cid, summ in summaries.items():
        lines = summary_lines(summ)
        if lines:
            L.append(f"**`{cid}`**")
            L.append("")
            L += lines
            L.append("")


def _sec_dataset_stats(report: DatasetReport, L: list[str]) -> None:
    st = report.dataset_stats or {}
    if not st:
        return
    grouped: dict[str, dict[str, Any]] = {}
    per_cam: dict[str, dict[str, Any]] = {}
    scalars: list[list[Any]] = []
    for k, v in st.items():
        if isinstance(v, dict):
            per_cam[k] = v
        elif "." in k and k.rsplit(".", 1)[1] in ("median", "min", "max"):
            base, agg = k.rsplit(".", 1)
            grouped.setdefault(base, {})[agg] = v
        else:
            scalars.append([k, _num(v)])
    L.append("### Dataset statistics (across the evaluated episodes)")
    L.append("")
    if grouped:
        L += _table(
            ["metric", "median", "min", "max"],
            [
                [f"`{k}`", _num(v.get("median")), _num(v.get("min")), _num(v.get("max"))]
                for k, v in grouped.items()
            ],
        )
        L.append("")
    cams = sorted({c for v in per_cam.values() for c in v})
    if cams and per_cam:
        L += _table(
            ["camera"] + [f"`{k}`" for k in per_cam],
            [[c] + [_num(per_cam[k].get(c), 3) for k in per_cam] for c in cams],
        )
        L.append("")
    if scalars:
        L += _table(["statistic", "value"], [[f"`{k}`", v] for k, v in scalars])
        L.append("")


def _sec_scores(report: DatasetReport, L: list[str], episodes: list[int] | None) -> None:
    hard_ids, soft_ids = _critic_ids(report)
    order = _ordered(report, episodes)
    L.append("## Episode scores (worst first)")
    L.append("")
    if not order:
        L.append("_no episodes selected_")
        L.append("")
        return
    head = (
        ["episode", "verdict", "total", "hard", "soft", "duration s", "frames"]
        + hard_ids
        + soft_ids
        + ["gates failed", "flags"]
    )
    rows = []
    for r in order:
        hs = {h.id: h.score for h in r.hard}
        ss = {s.id: s.score for s in r.soft}
        rows.append(
            [
                r.episode,
                r.score.verdict,
                _score(r.score.total),
                _score(r.score.hard_score),
                _score(r.score.soft_score),
                f"{r.duration_s:.1f}",
                r.length,
            ]
            + [_score(hs.get(i)) for i in hard_ids]
            + [_score(ss.get(i)) for i in soft_ids]
            + [", ".join(r.score.gates_failed) or "–", " ".join(r.score.flags) or "–"]
        )
    L += _table(head, rows)
    L.append("")


def _episode_block(r: EpisodeReport, L: list[str], level: int = 3) -> None:
    h = "#" * level
    L.append(f"{h} Episode {r.episode} — {r.score.verdict} (total {_score(r.score.total)})")
    L.append("")
    L.append(
        f"- duration {r.duration_s:.1f} s · {r.length} frames · hard {_score(r.score.hard_score)} · "
        f"soft {_score(r.score.soft_score)}" + (f" · task: {r.task}" if r.task else "")
    )
    if r.error:
        L.append(f"- **critic run failed**: {r.error.splitlines()[0]}")
    if r.score.gates_failed:
        L.append(f"- **gates failed**: {', '.join(f'`{g}`' for g in r.score.gates_failed)}")
    if r.score.flags:
        L.append("- **flags**: " + ", ".join(f"`{f}`" for f in r.score.flags))
    if r.score.reasons:
        L.append("- **why**:")
        for reason in r.score.reasons:
            L.append(f"  - {reason}")
    L.append("")
    critics: list[CriticResult] = list(r.hard) + [s for s in r.soft if s.id != "vlm.summary"]
    if critics:
        rows = []
        for c in critics:
            status = "GATE FAILED" if c.gate_failed else ("passed" if c.gate else "–")
            evidence = f"error: {c.error}" if c.error else "; ".join(e for e in c.evidence if e)
            rows.append(
                [
                    f"`{c.id}`",
                    c.kind,
                    _num(c.weight),
                    _score(c.score),
                    status,
                    " ".join(c.flags) or "–",
                    evidence or "–",
                ]
            )
        L += _table(["critic", "kind", "weight", "score", "gate", "flags", "evidence"], rows)
        L.append("")
    metrics_lines = []
    for c in r.hard:
        kv = _kv_metrics(c.metrics)
        if kv:
            metrics_lines.append(f"- `{c.id}`: {kv}")
    for c in r.soft:
        if c.id == "vlm.summary":
            continue
        conf = c.metrics.get("confidence") if isinstance(c.metrics, dict) else None
        if conf is not None:
            metrics_lines.append(f"- `{c.id}`: confidence={_num(conf, 2)}")
    if metrics_lines:
        L.append("**Metrics**")
        L.append("")
        L += metrics_lines
        L.append("")
    summ = next((s for s in r.soft if s.id == "vlm.summary"), None)
    if summ is not None:
        _vlm_block(summ, L)


def _vlm_block(summ: CriticResult, L: list[str]) -> None:
    m = summ.metrics if isinstance(summ.metrics, dict) else {}
    usage = m.get("usage") if isinstance(m.get("usage"), dict) else {}
    meta = [x for x in (m.get("model"), m.get("mode")) if x]
    if usage.get("total_tokens"):
        meta.append(f"{usage['total_tokens']} tokens")
    if m.get("latency_s"):
        meta.append(f"{float(m['latency_s']):.0f} s")
    if m.get("cached"):
        meta.append("cached")
    L.append("**VLM judge**" + (f" ({' · '.join(str(x) for x in meta)})" if meta else ""))
    L.append("")
    if summ.error:
        L.append(f"- error: {summ.error}")
        L.append("")
        return
    ts = m.get("task_success")
    L.append(
        f"- task_success: **{ts if ts is not None else 'unknown'}**"
        + (f" · confidence {_num(m.get('confidence'), 2)}" if m.get("confidence") is not None else "")
        + (f" · flags: {' '.join(summ.flags)}" if summ.flags else "")
    )
    if summ.evidence and summ.evidence[0]:
        L.append(f"- summary: {summ.evidence[0]}")
    attempts = m.get("attempts") if isinstance(m.get("attempts"), list) else []
    if attempts:
        L.append("")
        L += _table(
            ["attempt", "grasp s", "release s", "placed correctly"],
            [
                [
                    i + 1,
                    _num(a.get("grasp_time_s"), 1),
                    _num(a.get("release_time_s"), 1),
                    _num(a.get("placed_correctly")),
                ]
                for i, a in enumerate(attempts)
                if isinstance(a, dict)
            ],
        )
    anomalies = m.get("anomalies") if isinstance(m.get("anomalies"), list) else []
    if anomalies:
        L.append("")
        L += _table(
            ["anomaly", "time s", "severity", "description"],
            [
                [a.get("type"), _num(a.get("time_s"), 1), a.get("severity"), a.get("description")]
                for a in anomalies
                if isinstance(a, dict)
            ],
        )
    L.append("")


# ------------------------------------------------------------------ public API
def render_ai_markdown(report: DatasetReport, detail: str = "full", episodes: list[int] | None = None) -> str:
    """Whole run as self-contained Markdown.

    ``detail``: ``summary`` (no per-episode sections), ``flagged`` (details for review/reject
    episodes), ``full`` (details for every episode). ``episodes`` restricts the score table
    and the detail sections to a subset; the run summary always covers the whole run.
    """
    if detail not in DETAIL_LEVELS:
        raise ValueError(f"detail must be one of {DETAIL_LEVELS}, got {detail!r}")
    L: list[str] = []
    _sec_header(report, L)
    _sec_run(report, L)
    _sec_task(report, L)
    _sec_checks(report, L)
    _sec_summary(report, L)
    _sec_scores(report, L, episodes)
    if detail != "summary":
        order = _ordered(report, episodes)
        if detail == "flagged":
            order = [r for r in order if r.score.verdict != "accept"]
        if order:
            L.append("## Episode details" + (" (review / reject only)" if detail == "flagged" else ""))
            L.append("")
            for r in order:
                _episode_block(r, L)
    L += metric_glossary_lines(report)
    return "\n".join(L).rstrip() + "\n"


def render_episode_markdown(report: DatasetReport, episode: int) -> str:
    """One episode with just enough run context to be understood on its own."""
    r = next((e for e in report.episodes if e.episode == episode), None)
    if r is None:
        raise KeyError(f"episode {episode} not in report")
    spec = _spec(report)
    # under per_episode the episode's own recorded task is what it was judged against
    task = (
        (r.task if _per_episode_tasks(report) else None)
        or (spec.get("task") or {}).get("instruction")
        or r.task
        or "–"
    )
    sc = spec.get("scoring") or {}
    L: list[str] = []
    L.append(f"# lerobot-critics · {report.dataset_name} · episode {r.episode}")
    L.append("")
    L.append(
        f"> Episode-quality verdict from lerobot-critics {__version__} (spec **{report.spec_name}**). "
        f"Task: {task}. Scores are in [0, 1] (1 = good); accept ≥ {_num(sc.get('accept_threshold', 0.75))}, "
        f"review ≥ {_num(sc.get('review_threshold', 0.55))}, else reject; a failed gate rejects regardless "
        "of the score. Flags: "
        + (", ".join(f"`{f}` = {flag_meaning(f)}" for f in r.score.flags) if r.score.flags else "none")
        + "."
    )
    L.append("")
    _episode_block(r, L, level=2)
    present = {f"{c.id}.{k}" for c in r.hard for k in c.metrics if not k.startswith("_")}
    L += metric_glossary_lines(report, "## Metric glossary (this episode)", only=present)
    return "\n".join(L).rstrip() + "\n"


def load_report(source: str | Path) -> DatasetReport:
    """``DatasetReport`` from a run's output directory (``report.json`` inside) or the JSON file itself."""
    from .runner import DatasetReport

    p = Path(source)
    if p.is_dir():
        p = p / "report.json"
    if not p.is_file():
        raise FileNotFoundError(f"no report.json at {source}")
    return DatasetReport.model_validate(json.loads(p.read_text()))
