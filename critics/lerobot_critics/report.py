"""Report writers: report.json, episodes.csv, report.md, report_ai.md, report.html, selection.json, sheets."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import TYPE_CHECKING

from .ai_report import metric_glossary_lines, render_ai_markdown, session_profile_lines, summary_lines
from .metrics_doc import describe_metric
from .selection import (
    filtered_episodes,
    flag_impact,
    impact_text,
    purpose_of,
    selection_lists,
    tuning_snippet,
)
from .visual_report import write_html_report

if TYPE_CHECKING:  # pragma: no cover
    from .dataset.loader import LeRobotDataset
    from .runner import DatasetReport, EpisodeReport


def write_reports(report: DatasetReport, out_dir: Path, ds: LeRobotDataset | None = None) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(report.model_dump_json(indent=1))
    (out_dir / "selection.json").write_text(json.dumps(build_selection(report), indent=1))
    write_csv(report, out_dir / "episodes.csv")
    write_columns_csv(report, out_dir / "episodes.csv", out_dir / "episodes_columns.csv")
    (out_dir / "report.md").write_text(render_markdown(report))
    # self-contained variant for LLMs / agents (task, checks, glossary, every episode in detail)
    (out_dir / "report_ai.md").write_text(render_ai_markdown(report, detail="full"))
    if ds is not None:
        sheets = out_dir / "sheets"
        for r in report.episodes:
            if r.score.verdict != "accept":
                try:
                    contact_sheet(ds, r, sheets / f"episode_{r.episode:06d}.jpg")
                except Exception:  # noqa: BLE001 - sheets are a convenience
                    pass
    # visual report last: it embeds the contact sheets written above
    try:
        write_html_report(report, out_dir)
    except Exception:  # noqa: BLE001 - the machine-readable reports are what matters
        pass


def build_selection(report: DatasetReport) -> dict:
    """``selection.json``: which episodes to filter, why each one, and what to switch off.

    ``include``/``review``/``exclude`` are the episode numbers, ``ranges`` the same as
    ``"0-4,7"`` for a ``--episodes`` filter, ``reasons`` carries one entry per filtered
    episode (``cause`` = gate / flag / score, ``blocking`` = the flags that decided it) and
    ``switchable`` says how many episodes each finding would give back if it were muted.
    """
    lists = selection_lists(report)
    return {
        "dataset": report.dataset,
        "spec": report.spec_name,
        "include": report.include,
        "review": report.review,
        "exclude": report.exclude,
        "ranges": {k: v["ranges"] for k, v in lists.items()},
        "include_with_review": sorted(report.include + report.review),
        "reasons": {
            str(d["episode"]): {
                "verdict": d["verdict"],
                "total": d["total"],
                "cause": d["cause"],
                "why": d["headline"],
                "blocking": d["blocking"],
                "gates": d["gates"],
                "flags": d["flags"],
                "reasons": d["details"],
            }
            for d in filtered_episodes(report)
        },
        "switchable": [
            {
                "flag": d["flag"],
                "effect": d["effect"],
                "episodes": d["episodes"],
                "decides": d["decides"],
                "would_accept": d["would_accept"],
                "critics": d["critics"],
            }
            for d in flag_impact(report)
            if d["decides"]
        ],
    }


def _flat_metrics(r: EpisodeReport) -> dict:
    row: dict = {}
    for h in r.hard:
        row[f"hard.{h.id}"] = None if h.score is None else round(h.score, 3)
        for k, v in h.metrics.items():
            if k.startswith("_"):
                continue  # private intermediates for dataset-level summaries
            if isinstance(v, (int, float)) and not isinstance(v, bool) and not k.startswith("z."):
                row[f"{h.id}.{k}"] = round(v, 4) if isinstance(v, float) else v
    for s in r.soft:
        if s.weight > 0 or s.id == "vlm.summary":
            row[s.id] = None if s.score is None else round(s.score, 3)
    return row


def write_csv(report: DatasetReport, path: Path) -> None:
    rows = []
    for r in report.episodes:
        base = {
            "episode": r.episode,
            "verdict": r.score.verdict,
            "total": None if r.score.total is None else round(r.score.total, 3),
            "hard_score": None if r.score.hard_score is None else round(r.score.hard_score, 3),
            "soft_score": None if r.score.soft_score is None else round(r.score.soft_score, 3),
            "gates": "|".join(r.score.gates_failed),
            "flags": "|".join(r.score.flags),
            "duration_s": round(r.duration_s, 1),
            "frames": r.length,
        }
        base.update(_flat_metrics(r))
        rows.append(base)
    cols: list[str] = []
    for row in rows:
        for k in row:
            if k not in cols:
                cols.append(k)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


def _column_doc(report: DatasetReport, col: str) -> dict:
    """Description of one episodes.csv column (score columns, base columns, critic metrics)."""
    fixed = {
        "episode": ("", "", "Episode index in the dataset."),
        "verdict": ("", "", "accept / review / reject after gates, thresholds and review flags."),
        "total": ("", "0..1", "Weighted mean of hard_score and soft_score (1 = good)."),
        "hard_score": ("", "0..1", "Weighted mean of the hard (deterministic) critic scores."),
        "soft_score": ("", "0..1", "Weighted mean of the VLM success indicators."),
        "gates": ("", "list", "Critics whose gate fired (|-separated); any gate rejects the episode."),
        "flags": ("", "list", "All flags raised on the episode (|-separated); see the flag glossary."),
        "duration_s": ("", "s", "Episode length in seconds."),
        "frames": ("", "frames", "Episode length in frames."),
    }
    if col in fixed:
        critic, unit, what = fixed[col]
        return {"column": col, "critic": critic, "unit": unit, "better": "", "description": what, "how": ""}
    if col.startswith("hard."):
        return {
            "column": col,
            "critic": col[5:],
            "unit": "0..1",
            "better": "higher",
            "description": f"Score of the hard critic '{col[5:]}' (1 = good).",
            "how": "linear ramps between the critic's good/bad thresholds",
        }
    if col.startswith("vlm."):
        return {
            "column": col,
            "critic": "vlm",
            "unit": "0..1",
            "better": "higher",
            "description": f"VLM success indicator '{col[4:]}' (1 = fully satisfied).",
            "how": "judged by the vision-language model from the composite video",
        }
    hard_ids = sorted({h.id for r in report.episodes for h in r.hard}, key=len, reverse=True)
    for cid in hard_ids:
        if col.startswith(cid + "."):
            key = col[len(cid) + 1 :]
            d = describe_metric(cid, key)
            if d is None:
                return {"column": col, "critic": cid, "unit": "", "better": "", "description": "", "how": ""}
            feat = key[len(d.key.rstrip(".")) + 1 :] if d.per_feature and key != d.key else ""
            what = d.what + (f" Feature: {feat}." if feat else "")
            return {
                "column": col,
                "critic": cid,
                "unit": d.unit,
                "better": d.better,
                "description": what,
                "how": d.how,
            }
    return {"column": col, "critic": "", "unit": "", "better": "", "description": "", "how": ""}


def write_columns_csv(report: DatasetReport, episodes_csv: Path, path: Path) -> None:
    """Companion of episodes.csv: what and how every column measures, for operators."""
    with episodes_csv.open(newline="") as f:
        cols = next(csv.reader(f), [])
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["column", "critic", "unit", "better", "description", "how"])
        w.writeheader()
        for c in cols:
            w.writerow(_column_doc(report, c))


def _md(text: str) -> str:
    """Escape the characters that would break a markdown table cell."""
    return str(text).replace("|", "\\|").replace("\n", " ")


def _fmt(x) -> str:
    if x is None:
        return "–"
    if isinstance(x, float):
        return f"{x:.2f}"
    return str(x)


def render_markdown(report: DatasetReport) -> str:
    L: list[str] = []
    L.append(f"# Critic report: {report.dataset_name}")
    L.append("")
    L.append(f"- Dataset: `{report.dataset}`  ")
    L.append(
        f"- Spec: **{report.spec_name}** · robot `{report.robot_type}` · {report.fps:g} fps · {len(report.cameras)} cameras  "
    )
    L.append(
        f"- Created: {report.created_at} · runtime {report.timing_s.get('total_s', 0):.0f}s "
        f"(hard {report.timing_s.get('hard_s', 0):.0f}s, VLM {report.timing_s.get('soft_s', 0):.0f}s)"
    )
    L.append("")
    c = report.counts
    L.append(
        f"## Verdicts: {c.get('accept', 0)} accept · {c.get('review', 0)} review · {c.get('reject', 0)} reject "
        f"(of {report.n_episodes})"
    )
    L.append("")
    lists = selection_lists(report)
    evaluation = purpose_of(report) == "evaluation"
    labels = (
        (("accept", "success"), ("review", "review"), ("reject", "failure"))
        if evaluation
        else (("accept", "include"), ("review", "review"), ("reject", "exclude"))
    )
    for key, label in labels:
        d = lists[key]
        L.append(f"- {label} ({d['n']}, {d['meaning']}): `{d['episodes']}`")
        if d["episodes"]:
            L.append(f"  - as a filter: `{d['ranges']}`")
    if not evaluation:
        L.append(f"- include + review: `{sorted(report.include + report.review)}`")
    L.append("")
    if report.flag_counts:
        L.append("## Flags")
        L.append("")
        L.append("| flag | episodes |")
        L.append("|---|---|")
        for k, v in report.flag_counts.items():
            L.append(f"| `{k}` | {v} |")
        L.append("")
    L += session_profile_lines(report)
    if report.dataset_flags or report.dataset_summaries:
        L.append("## Dataset-level findings")
        L.append("")
        L.append(
            "Findings about the run as a whole (not the fault of any single rollout)."
            if evaluation
            else "Findings about the recording session as a whole (not the fault of any single episode): "
            "spatial diversity, normalisation statistics, action-space hygiene."
        )
        L.append("")
        for flag, why in report.dataset_flags.items():
            L.append(f"- **`{flag}`** — {why}")
        if report.dataset_flags:
            L.append("")
        for cid, summ in report.dataset_summaries.items():
            lines = summary_lines(summ)
            if lines:
                L.append(f"**{cid}**")
                L.append("")
                L += lines
                L.append("")
    if report.dataset_stats:
        L.append("## Dataset statistics")
        L.append("")
        for k, v in report.dataset_stats.items():
            if isinstance(v, dict):
                L.append(
                    f"- **{k}**: "
                    + ", ".join(
                        f"`{kk.split('.')[-2] if kk.endswith('.color') else kk}`={vv:.3f}"
                        for kk, vv in v.items()
                    )
                )
            else:
                L.append(f"- **{k}**: {_fmt(v)}")
        L.append("")
    hard_ids = []
    soft_ids = []
    for r in report.episodes:
        for h in r.hard:
            if h.id not in hard_ids:
                hard_ids.append(h.id)
        for s in r.soft:
            if s.weight > 0 and s.id not in soft_ids:
                soft_ids.append(s.id)
    L.append("## Episodes (worst first)")
    L.append("")
    head = (
        ["ep", "verdict", "total", "hard", "soft"]
        + hard_ids
        + [s.replace("vlm.", "vlm:") for s in soft_ids]
        + ["flags"]
    )
    L.append("| " + " | ".join(head) + " |")
    L.append("|" + "---|" * len(head))
    order = sorted(report.episodes, key=lambda r: r.score.total if r.score.total is not None else -1)
    for r in order:
        hs = {h.id: h.score for h in r.hard}
        ss = {s.id: s.score for s in r.soft}
        row = [
            str(r.episode),
            r.score.verdict,
            _fmt(r.score.total),
            _fmt(r.score.hard_score),
            _fmt(r.score.soft_score),
        ]
        row += [_fmt(hs.get(i)) for i in hard_ids] + [_fmt(ss.get(i)) for i in soft_ids]
        row.append(" ".join(f"`{f}`" for f in r.score.flags))
        L.append("| " + " | ".join(row) + " |")
    L.append("")
    L += metric_glossary_lines(report)
    rows = filtered_episodes(report)
    if rows:
        if evaluation:
            L.append(f"## Why these {len(rows)} rollouts were not counted as a success")
            L.append("")
            L.append(
                "`decided by` is what you would have to switch off for the rollout to count as a success."
            )
        else:
            L.append(f"## Why these {len(rows)} episodes were filtered")
            L.append("")
            L.append("`decided by` is what you would have to switch off to get the episode back.")
        L.append("")
        L.append("| ep | verdict | total | why | decided by | other findings |")
        L.append("|---|---|---|---|---|---|")
        for d in rows:
            other = [f for f in d["flags"] if f not in d["blocking"]]
            L.append(
                f"| {d['episode']} | {d['verdict']} | {_fmt(d['total'])} | {_md(d['headline'])} | "
                + (" ".join(f"`{f}`" for f in d["blocking"]) or "score only")
                + " | "
                + (" ".join(f"`{f}`" for f in other) or "")
                + " |"
            )
        L.append("")
    switchable = [d for d in flag_impact(report) if d["decides"]]
    if switchable:
        L.append("## Criteria you can switch off")
        L.append("")
        L.append(
            "A finding that does not apply to this setup can be muted for the whole dataset via "
            "`scoring.ignore_flags`. `if muted` is a replay of this run with the flag muted; muting "
            "removes a gate and a review cap, never the score a critic gave."
        )
        L.append("")
        L.append("| finding | effect on the verdict | episodes | decides | if muted |")
        L.append("|---|---|---|---|---|")
        for d in switchable:
            L.append(
                f"| `{d['flag']}` | {d['effect']} | {d['n']} | {len(d['decides'])} | "
                + (impact_text(d) or "nothing – those episodes are filtered by their score too")
                + " |"
            )
        L.append("")
        snippet = tuning_snippet([d for d in switchable if d["would_improve"]] or switchable[:1])
        if snippet:
            L.append("```yaml")
            L.append(snippet)
            L.append("```")
            L.append("")
    bad = [r for r in order if r.score.verdict != "accept"]
    if bad:
        L.append(
            "## Details for rollouts without success"
            if evaluation
            else "## Details for non-accepted episodes"
        )
        L.append("")
        for r in bad:
            L.append(f"### Episode {r.episode} — {r.score.verdict} (total {_fmt(r.score.total)})")
            if r.score.gates_failed:
                L.append(f"- gates failed: {', '.join(r.score.gates_failed)}")
            for reason in r.score.reasons:
                L.append(f"- {reason}")
            summ = next((s for s in r.soft if s.id == "vlm.summary"), None)
            if summ is not None:
                if summ.error:
                    L.append(f"- VLM error: {summ.error}")
                elif summ.evidence:
                    L.append(f"- VLM: {summ.evidence[0]}")
                    for e in summ.evidence[1:6]:
                        L.append(f"  - {e}")
            L.append("")
    return "\n".join(L)


def contact_sheet(ds: LeRobotDataset, r: EpisodeReport, path: Path, n: int = 8, tile_w: int = 320) -> None:
    """Primary camera on top, other cameras below; n evenly spaced frames plus grasp keyframes."""
    import cv2
    import numpy as np

    ep = ds.episode(r.episode)
    idx = sorted(
        set(np.linspace(0, ep.length - 1, n).astype(int).tolist())
        | set(int(g) for g in r.keyframes.get("grasp", [])[:6])
    )
    rows = []
    for cam in ep.cameras:
        frames = dict(ep.frames(cam, indices=idx, max_side=tile_w))
        tiles = []
        for i in idx:
            img = frames.get(i)
            if img is None:
                continue
            h = int(img.shape[0] * tile_w / img.shape[1])
            img = cv2.resize(img, (tile_w, h))
            cv2.putText(img, f"{i / ep.fps:.1f}s", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 2)
            tiles.append(img)
        if tiles:
            h = min(t.shape[0] for t in tiles)
            rows.append(np.concatenate([t[:h] for t in tiles], axis=1))
    if not rows:
        return
    w = min(rw.shape[1] for rw in rows)
    sheet = np.concatenate([rw[:, :w] for rw in rows], axis=0)
    banner = np.zeros((28, sheet.shape[1], 3), np.uint8)
    text = f"ep {r.episode}  {r.score.verdict}  total={_fmt(r.score.total)}  flags={' '.join(r.score.flags)[:120]}"
    cv2.putText(banner, text, (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)
    sheet = np.concatenate([banner, sheet], axis=0)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 80])
