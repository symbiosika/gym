"""Score a finished run against episodes a person labelled (``lerobot-critics eval``).

A run is only as useful as its verdicts agree with a careful person. This compares the
verdicts and flags of a run with a label file and says how many rejects were right
(precision), how many bad episodes were caught (recall), what every flag is worth, and which
of the person's reasons the run catches. Use it as the regression check for every change to a
spec, a threshold or the VLM prompt.

Two label formats are read:

- the ``meta/subset_provenance.json`` a filtered copy of a dataset carries:
  ``excluded`` ({episode: [reasons]}) are the bad episodes, the keys of
  ``source_to_new_episode_index`` the good ones;
- a plain file ``{"exclude": [episodes] | {episode: [reasons]}, "include": [episodes]}``.
  Without ``include`` every other episode of the run counts as good.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .runner import DatasetReport

VERDICTS = ("accept", "review", "reject")


@dataclass
class Labels:
    # bad episode -> the person's reasons (may be empty)
    bad: dict[int, list[str]]
    # the good episodes; None = every other episode of the run
    good: set[int] | None


def _bad(value: Any) -> dict[int, list[str]]:
    if isinstance(value, dict):
        return {
            int(k): [str(x) for x in (v if isinstance(v, list) else [v] if v else [])]
            for k, v in value.items()
        }
    return {int(e): [] for e in value or []}


def load_labels(path: str | Path) -> Labels:
    data = json.loads(Path(path).read_text())
    if "excluded" in data:
        good = {int(k) for k in data.get("source_to_new_episode_index") or {}}
        return Labels(bad=_bad(data["excluded"]), good=good or None)
    if "exclude" in data:
        keep = data.get("include", data.get("keep"))
        return Labels(bad=_bad(data["exclude"]), good={int(e) for e in keep} if keep is not None else None)
    raise ValueError("a label file needs 'excluded' (subset_provenance.json) or 'exclude'")


def _pr(tp: int, fp: int, fn: int) -> dict[str, Any]:
    return {
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "tp": tp,
        "fp": fp,
        "fn": fn,
    }


def compare(report: DatasetReport, labels: Labels) -> dict[str, Any]:
    """Verdicts and flags of ``report`` against ``labels``; episodes without a label are left out."""
    verdict = {e.episode: e.score.verdict for e in report.episodes}
    flags = {e.episode: set(e.score.flags) for e in report.episodes}
    good_set = labels.good if labels.good is not None else set(verdict) - set(labels.bad)
    bad = sorted(e for e in labels.bad if e in verdict)
    good = sorted(e for e in good_set if e in verdict and e not in labels.bad)
    labelled = set(bad) | set(good)

    confusion = {v: {"bad": 0, "good": 0} for v in VERDICTS}
    for e in labelled:
        confusion[verdict[e]]["bad" if e in labels.bad else "good"] += 1

    def pr(predicted: set[int]) -> dict[str, Any]:
        tp = len(predicted & set(bad))
        return _pr(tp, len(predicted & set(good)), len(bad) - tp)

    rejected = {e for e in labelled if verdict[e] == "reject"}
    filtered = {e for e in labelled if verdict[e] != "accept"}

    rows = []
    for f in sorted({f for e in labelled for f in flags[e]}):
        on_bad = sum(f in flags[e] for e in bad)
        on_good = sum(f in flags[e] for e in good)
        rows.append(
            {
                "flag": f,
                "on_bad": on_bad,
                "on_good": on_good,
                "precision": on_bad / (on_bad + on_good),
                "recall": on_bad / len(bad) if bad else None,
            }
        )
    rows.sort(key=lambda r: (-(r["on_bad"] + r["on_good"]), r["flag"]))

    reasons = []
    for reason in sorted({x for e in bad for x in labels.bad[e]}):
        eps = [e for e in bad if reason in labels.bad[e]]
        reasons.append(
            {"reason": reason, "n": len(eps), **{v: sum(verdict[e] == v for e in eps) for v in VERDICTS}}
        )

    return {
        "n": len(labelled),
        "n_bad": len(bad),
        "n_good": len(good),
        "unlabelled": sorted(set(verdict) - labelled),
        "confusion": confusion,
        "reject": pr(rejected),
        "filtered": pr(filtered),
        "flags": rows,
        "reasons": reasons,
        "good_rejected": sorted(rejected & set(good)),
        "bad_accepted": sorted(e for e in bad if verdict[e] == "accept"),
    }


def _pct(x: float | None) -> str:
    return "-" if x is None else f"{100 * x:.0f}%"


def render_text(res: dict[str, Any]) -> str:
    """The comparison as plain text for a terminal."""
    from .selection import compact_ranges

    c = res["confusion"]
    lines = [
        f"{res['n']} labelled episodes: {res['n_bad']} bad, {res['n_good']} good"
        + (f" ({len(res['unlabelled'])} without a label left out)" if res["unlabelled"] else ""),
        "",
        "verdict    bad  good",
        *(f"{v:8s} {c[v]['bad']:5d} {c[v]['good']:5d}" for v in VERDICTS),
        "",
        f"reject precision {_pct(res['reject']['precision'])} · recall {_pct(res['reject']['recall'])}"
        "   (a reject is a bad episode · a bad episode is rejected)",
        f"filter precision {_pct(res['filtered']['precision'])} · recall {_pct(res['filtered']['recall'])}"
        "   (review or reject counted as filtered)",
        f"good episodes rejected: {compact_ranges(res['good_rejected']) or '-'}",
        f"bad episodes accepted:  {compact_ranges(res['bad_accepted']) or '-'}",
    ]
    if res["reasons"]:
        lines += ["", "the person's reasons   n  reject  review  accept"]
        lines += [
            f"{r['reason']:20s} {r['n']:4d} {r['reject']:7d} {r['review']:7d} {r['accept']:7d}"
            for r in res["reasons"]
        ]
    if res["flags"]:
        lines += ["", "flag                      on bad  on good  precision  recall"]
        lines += [
            f"{r['flag']:24s} {r['on_bad']:7d} {r['on_good']:8d} {_pct(r['precision']):>10s} {_pct(r['recall']):>7s}"
            for r in res["flags"]
        ]
    return "\n".join(lines)
