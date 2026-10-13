"""Visual, printable HTML report of a critic run ("visual report").

``report.md`` is a skimmable text log, ``report_ai.md`` is written for a language model.
This module renders the same :class:`~lerobot_critics.runner.DatasetReport` as a **short
visual document** for people who have to decide something: one overview page with charts
(verdict split, score per episode, score distribution, which check is the weakest, which
findings occur most often) followed by a detail analysis of the *N* most conspicuous
episodes - not a per-episode dump.

The output is a single self-contained HTML file: inline CSS, hand-built inline SVG charts
(no JS libraries, no CDN) and the contact sheets embedded as data URIs, so it survives
being mailed around. It carries a print stylesheet (A4, page breaks between sections), so
"Print -> Save as PDF" in any browser produces a ~5 page PDF.

    lerobot-critics html critic_out/ -o report.html      # CLI
    GET /jobs/{id}/report.html?top=5                     # REST
    UI: "Visual report" on a finished job

``report.html`` is written next to ``report.md`` on every run.
"""

from __future__ import annotations

import base64
import html
import math
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import __version__
from .ai_report import _per_episode_tasks, flag_meaning
from .selection import (
    FLAG_ACTION as FLAG_ACTION,  # re-exported: the flag -> action table used to live here
)
from .selection import (
    filtered_episodes,
    flag_action,
    flag_impact,
    impact_text,
    purpose_of,
    selection_lists,
    tuning_snippet,
    verdict_meaning,
)
from .session_profile import build_session_profile, indicators_by_group

if TYPE_CHECKING:  # pragma: no cover
    from .critics.base import CriticResult
    from .runner import DatasetReport, EpisodeReport

# palette shared with the web UI
C_ACCEPT, C_REVIEW, C_REJECT = "#16a34a", "#ca8a04", "#dc2626"
C_ACC, C_MUT, C_LINE, C_GRID = "#2563eb", "#6b7684", "#e3e6ea", "#eef1f5"
VERDICT_COLOR = {"accept": C_ACCEPT, "review": C_REVIEW, "reject": C_REJECT}

# ------------------------------------------------------------------ small helpers
_e = html.escape


def _f(x: Any, digits: int = 2) -> str:
    if x is None or (isinstance(x, float) and x != x):
        return "–"
    if isinstance(x, float):
        return f"{x:.{digits}f}"
    return str(x)


def _duration(seconds: float) -> str:
    """Human recording time: seconds under a minute and a half, then minutes, then hours."""
    if seconds < 90:
        return f"{seconds:.0f} s"
    if seconds < 3600:
        m = seconds / 60
        return f"{m:.0f} min" if m >= 10 else f"{m:.1f} min"
    return f"{seconds / 3600:.1f} h"


def _score_color(s: float | None) -> str:
    if s is None:
        return "#cbd5e1"
    return C_ACCEPT if s >= 0.75 else C_REVIEW if s >= 0.5 else C_REJECT


def _metric_value(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:
            return "–"
        if abs(v) >= 100:
            return f"{v:.1f}"
        return f"{v:.2f}" if abs(v) >= 1 else f"{v:.3g}"
    if isinstance(v, list):
        return "[" + ", ".join(_metric_value(x) for x in v[:6]) + ("…]" if len(v) > 6 else "]")
    if isinstance(v, dict):
        return "{" + ", ".join(f"{k}: {_metric_value(x)}" for k, x in list(v.items())[:4]) + "}"
    return str(v)


def _spec(report: DatasetReport) -> dict[str, Any]:
    return report.spec if isinstance(report.spec, dict) else {}


def _thresholds(report: DatasetReport) -> tuple[float, float]:
    sc = _spec(report).get("scoring") or {}
    return float(sc.get("accept_threshold", 0.75)), float(sc.get("review_threshold", 0.55))


def _gate_and_review_flags(report: DatasetReport) -> tuple[set[str], set[str]]:
    """Flags that reject an episode / cap it at review, according to the spec."""
    spec = _spec(report)
    gate: set[str] = set()
    for cfg in spec.get("hard_critics") or []:
        gate |= set(cfg.get("gate_flags") or [])
    sc = spec.get("scoring") or {}
    gate |= set(sc.get("reject_flags") or [])
    return gate, set(sc.get("review_flags") or [])


# ------------------------------------------------------------------ SVG charts
def _svg(w: int, h: int, body: str) -> str:
    return f'<svg viewBox="0 0 {w} {h}" preserveAspectRatio="xMidYMid meet" role="img">{body}</svg>'


def _text(
    x: float, y: float, s: str, size: int = 10, fill: str = C_MUT, anchor: str = "start", weight: str = "400"
) -> str:
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}" text-anchor="{anchor}" '
        f'font-weight="{weight}">{_e(s)}</text>'
    )


def _svg_donut(counts: dict[str, int], total: int) -> str:
    """Verdict split as a donut; the centre carries the accept rate."""
    r, sw, cx, cy = 52.0, 20.0, 70.0, 70.0
    circ = 2 * math.pi * r
    body = [f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{C_GRID}" stroke-width="{sw}"/>']
    off = 0.0
    for verdict in ("accept", "review", "reject"):
        n = counts.get(verdict, 0)
        if not n or total <= 0:
            continue
        seg = circ * n / total
        body.append(
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{VERDICT_COLOR[verdict]}" '
            f'stroke-width="{sw}" stroke-dasharray="{seg:.2f} {circ - seg:.2f}" '
            f'stroke-dashoffset="{-off:.2f}" transform="rotate(-90 {cx} {cy})"/>'
        )
        off += seg
    pct = 100.0 * counts.get("accept", 0) / total if total else 0.0
    body.append(_text(cx, cy + 6, f"{pct:.0f}%", 26, "#1c2430", "middle", "650"))
    body.append(_text(cx, cy + 22, "accepted", 11, C_MUT, "middle"))
    return _svg(140, 140, "".join(body))


def _svg_episode_scores(episodes: list[EpisodeReport], accept: float, review: float) -> str:
    """One bar per episode in recording order - shows drift over the session, not just a mean."""
    W, H = 760, 250
    ml, mr, mt, mb = 32, 72, 12, 30
    pw, ph = W - ml - mr, H - mt - mb
    eps = sorted(episodes, key=lambda r: r.episode)
    n = max(1, len(eps))
    bw = pw / n
    body: list[str] = []
    for gv in (0.0, 0.25, 0.5, 0.75, 1.0):
        y = mt + ph * (1 - gv)
        body.append(f'<line x1="{ml}" y1="{y:.1f}" x2="{ml + pw}" y2="{y:.1f}" stroke="{C_LINE}"/>')
        body.append(_text(ml - 6, y + 3, f"{gv:.2f}", 10, C_MUT, "end"))
    inner = min(46.0, max(0.5, bw * 0.8))  # thin lines for hundreds of episodes, real bars for a few
    for i, r in enumerate(eps):
        x = ml + i * bw + (bw - inner) / 2
        s = r.score.total
        if s is None:
            body.append(f'<rect x="{x:.1f}" y="{mt}" width="{inner:.1f}" height="{ph}" fill="{C_GRID}"/>')
            continue
        h = max(1.0, ph * min(1.0, max(0.0, s)))
        body.append(
            f'<rect x="{x:.1f}" y="{mt + ph - h:.1f}" width="{inner:.1f}" height="{h:.1f}" '
            f'fill="{VERDICT_COLOR[r.score.verdict]}" rx="1"/>'
        )
    step = max(1, math.ceil(n / 24))
    for i, r in enumerate(eps):
        if i % step == 0:
            body.append(_text(ml + i * bw + bw / 2, H - mb + 14, str(r.episode), 9, C_MUT, "middle"))
    body.append(_text(ml + pw / 2, H - 4, "episode (recording order)", 10, C_MUT, "middle"))
    for val, label, color in ((accept, "accept", C_ACCEPT), (review, "review", C_REVIEW)):
        y = mt + ph * (1 - min(1.0, max(0.0, val)))
        body.append(
            f'<line x1="{ml}" y1="{y:.1f}" x2="{ml + pw}" y2="{y:.1f}" stroke="{color}" '
            f'stroke-width="1.2" stroke-dasharray="4 3"/>'
        )
        body.append(_text(ml + pw + 5, y + 3, f"{label} {val:g}", 10, color))
    return _svg(W, H, "".join(body))


def _svg_histogram(values: list[float], accept: float, review: float, bins: int = 10) -> str:
    """Where the run's total scores sit relative to the accept / review thresholds."""
    W, H = 360, 220
    ml, mr, mt, mb = 30, 10, 20, 32
    pw, ph = W - ml - mr, H - mt - mb
    counts = [0] * bins
    for v in values:
        idx = min(bins - 1, max(0, int(v * bins)))
        counts[idx] += 1
    top = max(counts) or 1
    body: list[str] = [
        f'<line x1="{ml}" y1="{mt + ph}" x2="{ml + pw}" y2="{mt + ph}" stroke="{C_LINE}"/>',
        _text(ml - 6, mt + 8, str(top), 10, C_MUT, "end"),
        _text(ml - 6, mt + ph + 3, "0", 10, C_MUT, "end"),
    ]
    bw = pw / bins
    for i, c in enumerate(counts):
        centre = (i + 0.5) / bins
        color = C_ACCEPT if centre >= accept else C_REVIEW if centre >= review else C_REJECT
        h = ph * c / top
        x = ml + i * bw + 1.5
        if c:
            body.append(
                f'<rect x="{x:.1f}" y="{mt + ph - h:.1f}" width="{bw - 3:.1f}" height="{h:.1f}" '
                f'fill="{color}" rx="1"/>'
            )
            body.append(_text(x + (bw - 3) / 2, mt + ph - h - 3, str(c), 9, C_MUT, "middle"))
    for i in range(bins + 1):
        if i % 2 == 0:
            body.append(_text(ml + i * bw, mt + ph + 14, f"{i / bins:g}", 9, C_MUT, "middle"))
    body.append(_text(ml + pw / 2, H - 4, "total score", 10, C_MUT, "middle"))
    return _svg(W, H, "".join(body))


def _svg_hbars(
    rows: list[tuple[str, float, str, str]], vmax: float = 1.0, label_w: int = 130, width: int = 360
) -> str:
    """Horizontal bars: (label, value, right label, colour), one per row."""
    W = width
    rh, pad = 22, 8
    H = pad * 2 + rh * max(1, len(rows))
    bar_x, bar_w = label_w, W - label_w - 44
    body: list[str] = []
    for i, (label, value, right, color) in enumerate(rows):
        y = pad + i * rh
        body.append(_text(0, y + 14, label, 11, "#1c2430"))
        body.append(f'<rect x="{bar_x}" y="{y + 5}" width="{bar_w}" height="10" fill="{C_GRID}" rx="5"/>')
        w = bar_w * min(1.0, max(0.0, (value / vmax) if vmax else 0.0))
        if w > 0:
            body.append(f'<rect x="{bar_x}" y="{y + 5}" width="{w:.1f}" height="10" fill="{color}" rx="5"/>')
        body.append(_text(W, y + 14, right, 11, C_MUT, "end"))
    return _svg(W, H, "".join(body))


def _svg_series(
    series: dict[str, float],
    good: float | None,
    bad: float | None,
    better: str,
    unit: str,
    second: dict[str, float] | None = None,
    labels: tuple[str, str] = ("command", "robot"),
    W: int = 760,
    H: int = 200,
) -> str:
    """One bar per episode of a session indicator with the good / bad thresholds drawn in;
    ``second`` adds a thinner overlaid series (e.g. the robot state next to the command)."""
    ml, mr, mt, mb = 44, 96, 12, 30
    pw, ph = W - ml - mr, H - mt - mb
    keys = sorted(series, key=lambda k: int(k) if k.isdigit() else 0)
    n = max(1, len(keys))
    vals = [series[k] for k in keys] + ([second[k] for k in keys if k in second] if second else [])
    vmax = _nice_ceil(max([v for v in vals if v == v] + [good or 0, bad or 0, 1e-9]) * 1.15)
    body: list[str] = []
    for frac in (0.0, 0.5, 1.0):
        gv = vmax * frac
        y = mt + ph * (1 - frac)
        body.append(f'<line x1="{ml}" y1="{y:.1f}" x2="{ml + pw}" y2="{y:.1f}" stroke="{C_LINE}"/>')
        body.append(_text(ml - 6, y + 3, f"{gv:.3g}", 10, C_MUT, "end"))
    bw = pw / n
    inner = min(40.0, max(0.6, bw * 0.72))
    for i, k in enumerate(keys):
        v = series[k]
        x = ml + i * bw + (bw - inner) / 2
        h = max(1.0, ph * min(1.0, v / vmax))
        color = _status_color_value(v, good, bad, better)
        body.append(
            f'<rect x="{x:.1f}" y="{mt + ph - h:.1f}" width="{inner:.1f}" height="{h:.1f}" fill="{color}" rx="1"/>'
        )
        if second and k in second:
            v2 = second[k]
            h2 = max(1.0, ph * min(1.0, v2 / vmax))
            body.append(
                f'<rect x="{x + inner * 0.3:.1f}" y="{mt + ph - h2:.1f}" width="{inner * 0.4:.1f}" '
                f'height="{h2:.1f}" fill="#1c2430" opacity="0.55" rx="1"/>'
            )
    step = max(1, math.ceil(n / 24))
    for i, k in enumerate(keys):
        if i % step == 0:
            body.append(_text(ml + i * bw + bw / 2, H - mb + 14, k, 9, C_MUT, "middle"))
    body.append(_text(ml + pw / 2, H - 4, "episode (recording order)", 10, C_MUT, "middle"))
    for val, label, color in ((good, "good", C_ACCEPT), (bad, "bad", C_REJECT)):
        if val is None or val <= 0 or val > vmax:
            continue
        y = mt + ph * (1 - val / vmax)
        body.append(
            f'<line x1="{ml}" y1="{y:.1f}" x2="{ml + pw}" y2="{y:.1f}" stroke="{color}" '
            f'stroke-width="1.2" stroke-dasharray="4 3"/>'
        )
        body.append(_text(ml + pw + 5, y + 3, f"{label} {val:.3g} {unit}".strip(), 10, color))
    if second:  # legend in the right margin, below the threshold labels
        ly = H - mb - 30
        body.append(f'<rect x="{ml + pw + 5}" y="{ly}" width="10" height="10" fill="{C_REVIEW}"/>')
        body.append(_text(ml + pw + 19, ly + 9, labels[0], 10, C_MUT))
        body.append(
            f'<rect x="{ml + pw + 5}" y="{ly + 15}" width="10" height="10" fill="#1c2430" opacity="0.55"/>'
        )
        body.append(_text(ml + pw + 19, ly + 24, labels[1], 10, C_MUT))
    return _svg(W, H, "".join(body))


def _nice_ceil(v: float) -> float:
    """Round an axis maximum up to 1, 2, 2.5 or 5 × 10^k."""
    if v <= 0:
        return 1.0
    exp = math.floor(math.log10(v))
    base = 10.0**exp
    for m in (1.0, 2.0, 2.5, 5.0, 10.0):
        if v <= m * base:
            return m * base
    return 10.0 * base


def _status_color_value(v: float, good: float | None, bad: float | None, better: str) -> str:
    if good is None or bad is None or better not in ("lower", "higher"):
        return C_ACC
    if better == "lower":
        return C_ACCEPT if v <= good else C_REJECT if v >= bad else C_REVIEW
    return C_ACCEPT if v >= good else C_REJECT if v <= bad else C_REVIEW


def _svg_scatter(points: list[list[float]], spread_cm: float | None, W: int = 360, H: int = 300) -> str:
    """Top view (x/y, cm) of every grasp position of the run with a 5 cm reference square."""
    pts = [(p[0] * 100, p[1] * 100) for p in points if len(p) >= 2]
    if len(pts) < 2:
        return ""
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    half = max(max(xs) - min(xs), max(ys) - min(ys), 10.0) / 2 * 1.25  # at least a 10 cm window
    ml, mr, mt, mb = 40, 12, 12, 30
    pw, ph = W - ml - mr, H - mt - mb
    scale = min(pw, ph) / (2 * half)
    ox, oy = ml + pw / 2, mt + ph / 2

    def X(v: float) -> float:
        return ox + (v - cx) * scale

    def Y(v: float) -> float:
        return oy - (v - cy) * scale

    body: list[str] = []
    # grid every 5 cm
    g = 5.0
    start_x = math.floor((cx - half) / g) * g
    v = start_x
    while v <= cx + half:
        x = X(v)
        if ml <= x <= ml + pw:
            body.append(f'<line x1="{x:.1f}" y1="{mt}" x2="{x:.1f}" y2="{mt + ph}" stroke="{C_GRID}"/>')
            body.append(_text(x, mt + ph + 13, f"{v:.0f}", 9, C_MUT, "middle"))
        v += g
    v = math.floor((cy - half) / g) * g
    while v <= cy + half:
        y = Y(v)
        if mt <= y <= mt + ph:
            body.append(f'<line x1="{ml}" y1="{y:.1f}" x2="{ml + pw}" y2="{y:.1f}" stroke="{C_GRID}"/>')
            body.append(_text(ml - 5, y + 3, f"{v:.0f}", 9, C_MUT, "end"))
        v += g
    # 5 cm reference square around the median
    mx, my = sorted(xs)[len(xs) // 2], sorted(ys)[len(ys) // 2]
    s5 = 5.0 * scale
    body.append(
        f'<rect x="{X(mx) - s5 / 2:.1f}" y="{Y(my) - s5 / 2:.1f}" width="{s5:.1f}" height="{s5:.1f}" '
        f'fill="none" stroke="{C_REVIEW}" stroke-dasharray="3 3"/>'
    )
    body.append(_text(X(mx) + s5 / 2 + 4, Y(my) - s5 / 2 + 9, "5 cm", 9, C_REVIEW))
    for x, y in pts:
        body.append(f'<circle cx="{X(x):.1f}" cy="{Y(y):.1f}" r="3" fill="{C_ACC}" fill-opacity="0.45"/>')
    body.append(_text(ml + pw / 2, H - 4, "x [cm]", 10, C_MUT, "middle"))
    body.append(
        f'<text x="12" y="{mt + ph / 2:.0f}" font-size="10" fill="{C_MUT}" text-anchor="middle" transform="rotate(-90 12 {mt + ph / 2:.0f})">y [cm]</text>'
    )
    if spread_cm is not None:
        body.append(_text(ml + pw, mt + 10, f"robust std {spread_cm:g} cm", 10, "#1c2430", "end"))
    return _svg(W, H, "".join(body))


# ------------------------------------------------------------------ aggregations
def _critic_health(report: DatasetReport) -> list[tuple[str, float, str, str]]:
    """Mean score per critic over the run, worst first: which check is the run's weak spot."""
    acc: dict[str, list[float]] = {}
    flagged: dict[str, int] = {}
    for r in report.episodes:
        for c in list(r.hard) + [s for s in r.soft if s.weight > 0]:
            if c.score is not None and c.error is None:
                acc.setdefault(c.id, []).append(float(c.score))
            if c.flags or c.gate_failed:
                flagged[c.id] = flagged.get(c.id, 0) + 1
    rows = []
    for cid, vals in acc.items():
        mean = sum(vals) / len(vals)
        n = flagged.get(cid, 0)
        right = f"{mean:.2f}" + (f"  ({n} × ⚑)" if n else "")
        rows.append((cid.replace("vlm.", "vlm:"), mean, right, _score_color(mean)))
    return sorted(rows, key=lambda t: t[1])


def _finding_rows(report: DatasetReport, limit: int) -> list[dict[str, Any]]:
    """The most frequent flags of the run with the episodes they hit, meaning and action."""
    gate_flags, review_flags = _gate_and_review_flags(report)
    by_flag: dict[str, list[int]] = {}
    for r in report.episodes:
        for f in r.score.flags:
            by_flag.setdefault(f, []).append(r.episode)
    rank = {"gate": 0, "review": 1, "info": 2}

    def severity_of(flag: str) -> str:
        return "gate" if flag in gate_flags else "review" if flag in review_flags else "info"

    ranked = sorted(by_flag.items(), key=lambda kv: (rank[severity_of(kv[0])], -len(kv[1]), kv[0]))
    out = []
    for flag, eps in ranked[:limit]:
        severity = severity_of(flag)
        out.append(
            {
                "flag": flag,
                "episodes": eps,
                "severity": severity,
                "meaning": flag_meaning(flag),
                "action": flag_action(flag, purpose_of(report)),
            }
        )
    return out


def _severity_key(r: EpisodeReport) -> tuple:
    """Most conspicuous first: gate failures, then reject before review, then the lowest score."""
    rank = {"reject": 2, "review": 1, "accept": 0}[r.score.verdict]
    return (
        0 if r.score.gates_failed else 1,
        -rank,
        r.score.total if r.score.total is not None else -1.0,
        -len(r.score.flags),
        r.episode,
    )


def _weak_critics(r: EpisodeReport, limit: int = 3) -> list[CriticResult]:
    """The critics that pulled this episode down: gates and flags first, then the lowest scores."""
    cands = [c for c in list(r.hard) + list(r.soft) if c.id != "vlm.summary"]
    interesting = [c for c in cands if c.gate_failed or c.flags or (c.score is not None and c.score < 0.75)]
    interesting.sort(
        key=lambda c: (
            0 if c.gate_failed else 1,
            c.score if c.score is not None else -1.0,
            -len(c.flags),
        )
    )
    return interesting[:limit]


def _usable_seconds(report: DatasetReport) -> float:
    inc = set(report.include)
    return sum(r.duration_s for r in report.episodes if r.episode in inc)


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


# ------------------------------------------------------------------ images
def _sheet_data_uri(out_dir: Path | None, episode: int, max_w: int = 1000) -> str | None:
    """Contact sheet of one episode as a data URI, downscaled so the document stays mailable."""
    if out_dir is None:
        return None
    path = out_dir / "sheets" / f"episode_{episode:06d}.jpg"
    if not path.is_file():
        return None
    data = path.read_bytes()
    try:  # re-encode smaller; the sheets are wide (8 frames per camera row)
        import cv2
        import numpy as np

        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is not None and img.shape[1] > max_w:
            h = int(img.shape[0] * max_w / img.shape[1])
            img = cv2.resize(img, (max_w, h), interpolation=cv2.INTER_AREA)
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 72])
            if ok:
                data = buf.tobytes()
    except Exception:  # noqa: BLE001 - the raw sheet is a fine fallback
        pass
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


# ------------------------------------------------------------------ document
CSS = """
:root { --line:#e3e6ea; --txt:#1c2430; --mut:#6b7684; --acc:#2563eb; --grid:#eef1f5;
        --ok:#16a34a; --okbg:#dcfce7; --rev:#ca8a04; --revbg:#fef9c3; --bad:#dc2626; --badbg:#fee2e2; }
* { box-sizing:border-box }
body { margin:0; padding:28px 32px 48px; background:#f6f7f9; color:var(--txt);
       font:13.5px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
.doc { max-width:960px; margin:0 auto }
h1 { font-size:22px; margin:0 0 4px; font-weight:680 }
h2 { font-size:15px; margin:26px 0 10px; font-weight:660 }
h3 { font-size:13.5px; margin:0 0 4px; font-weight:650 }
p { margin:6px 0 }
.sub { color:var(--mut); font-size:12.5px }
.card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:12px 0 }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px }
.kpi { border:1px solid var(--line); border-radius:8px; padding:9px 11px }
.kpi b { display:block; font-size:21px; font-weight:660; line-height:1.2 }
.kpi span { color:var(--mut); font-size:11.5px }
.verdictrow { display:flex; gap:22px; align-items:center; flex-wrap:wrap }
.verdictrow .donut { flex:0 0 150px }
.verdictrow .legend { flex:1 1 220px; min-width:200px }
.legend div { display:flex; align-items:center; gap:7px; padding:2px 0 }
.dot { width:10px; height:10px; border-radius:3px; display:inline-block; flex:0 0 auto }
.charts { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start }
.chart { background:#fff; border:1px solid var(--line); border-radius:10px; padding:12px 14px }
.chart.wide { grid-column:1 / -1 }
.chart h3 { margin:0 0 2px }
.chart .sub { margin:0 0 6px }
svg { width:100%; height:auto; display:block; font-family:inherit }
table { width:100%; border-collapse:collapse; font-size:12.5px }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top }
th { color:var(--mut); font-weight:600; white-space:nowrap }
code, .flag { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px }
.flag { display:inline-block; background:var(--grid); border-radius:4px; padding:0 5px; margin:1px 3px 1px 0 }
.flag.gate { background:var(--badbg); color:var(--bad) } .flag.review { background:var(--revbg); color:var(--rev) }
.pill { display:inline-block; padding:1px 9px; border-radius:999px; font-size:11.5px; font-weight:650 }
.pill.accept { background:var(--okbg); color:var(--ok) } .pill.review { background:var(--revbg); color:var(--rev) }
.pill.reject { background:var(--badbg); color:var(--bad) }
.ep { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:12px 0;
      break-inside:avoid; page-break-inside:avoid }
.ep .head { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; margin-bottom:6px }
.ep .head .num { font-size:15px; font-weight:660 }
.ep .why { margin:6px 0 0; padding-left:18px; color:var(--txt) }
.ep .why li { margin:2px 0 }
.ep .metrics { color:var(--mut); font-size:11.5px; font-family:ui-monospace,Menlo,monospace }
.ep .critic { margin:8px 0 0; padding:8px 10px; background:#fafbfc; border:1px solid var(--line); border-radius:7px }
.ep .critic .top { display:flex; gap:8px; align-items:center; flex-wrap:wrap }
.ep img { width:100%; border:1px solid var(--line); border-radius:6px; margin-top:10px; background:#000 }
.bar { display:inline-block; width:54px; height:7px; background:var(--grid); border-radius:4px; overflow:hidden;
       vertical-align:middle }
.bar i { display:block; height:100% }
.mut { color:var(--mut) } .small { font-size:11.5px }
pre { margin:6px 0 0; padding:8px 10px; background:#fafbfc; border:1px solid var(--line); border-radius:7px;
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; line-height:1.45;
      white-space:pre-wrap; word-break:break-all; overflow-wrap:anywhere }
.pick { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:10px; margin-top:10px }
.pick > div { border:1px solid var(--line); border-radius:8px; padding:9px 11px; break-inside:avoid }
.pick h3 { margin:0 0 2px } .pick .eps { font-family:ui-monospace,Menlo,monospace; font-size:11.5px;
      word-break:break-all; overflow-wrap:anywhere; margin-top:4px }
td.why { line-height:1.45 } td.why b { font-weight:600 } td.why ul { margin:3px 0 0; padding-left:16px }
td.why li { margin:1px 0; color:var(--mut) }
.rec { font-size:14px; margin:10px 0 0 }
.footer { color:var(--mut); font-size:11.5px; margin-top:22px; border-top:1px solid var(--line); padding-top:10px }
.noprint button { font:inherit; padding:7px 12px; border-radius:6px; border:1px solid var(--acc);
                  background:var(--acc); color:#fff; cursor:pointer }
.pagebreak { break-before:page; page-break-before:always }
.headline { font-size:14px; margin:0 0 10px; padding:10px 14px; border-left:4px solid var(--rev); background:#fffbeb;
            border-radius:6px }
.headline.bad { border-color:var(--bad); background:#fef2f2 } .headline.good { border-color:var(--ok); background:#f0fdf4 }
.group { margin:14px 0 4px } .group h3 { font-size:13.5px; margin:0 } .group .sub { margin:0 0 6px }
.inds { display:grid; grid-template-columns:repeat(auto-fill,minmax(215px,1fr)); gap:10px }
.ind { position:relative; border:1px solid var(--line); border-radius:8px; padding:9px 11px 9px 14px; background:#fff;
       break-inside:avoid; page-break-inside:avoid }
.ind::before { content:""; position:absolute; left:0; top:8px; bottom:8px; width:4px; border-radius:2px; background:#cbd5e1 }
.ind.good::before { background:var(--ok) } .ind.warn::before { background:var(--rev) } .ind.bad::before { background:var(--bad) }
.ind .lbl { color:var(--mut); font-size:11.5px; line-height:1.3 }
.ind .val { font-size:20px; font-weight:660; line-height:1.25; margin:2px 0 }
.ind .val small { font-size:12px; font-weight:500; color:var(--mut); margin-left:3px }
.ind .xtra { font-size:11px; color:var(--mut) }
.ind .txt { font-size:11.5px; margin-top:5px; line-height:1.4 }
.ind .act { font-size:11px; color:var(--mut); margin-top:3px }
.ind .act b { color:var(--txt); font-weight:600 }
.ind .thr { font-size:10.5px; color:var(--mut); margin-top:3px }
.stat { display:inline-block; font-size:10.5px; font-weight:650; text-transform:uppercase; letter-spacing:.03em;
        padding:0 6px; border-radius:4px; margin-left:6px; vertical-align:middle }
.stat.good { background:var(--okbg); color:var(--ok) } .stat.warn { background:var(--revbg); color:var(--rev) }
.stat.bad { background:var(--badbg); color:var(--bad) } .stat.info { background:var(--grid); color:var(--mut) }
@media (max-width:820px) { .charts { grid-template-columns:1fr } }
@media print {
  @page { size:A4; margin:12mm }
  body { padding:0; background:#fff; font-size:10.5pt }
  .noprint { display:none }
  .card, .chart, .ep { break-inside:avoid; page-break-inside:avoid }
  * { -webkit-print-color-adjust:exact; print-color-adjust:exact }
}
"""


def _header(report: DatasetReport) -> str:
    t = report.timing_s
    meta = (
        f"{report.dataset_name} · spec <b>{_e(report.spec_name)}</b> · robot <code>{_e(report.robot_type or '?')}</code>"
        f" · {report.fps:g} fps · {len(report.cameras)} cameras · {report.n_episodes} episodes"
    )
    return (
        f"<h1>Dataset quality report: {_e(report.dataset_name)}</h1>"
        f'<div class="sub">{meta}</div>'
        f'<div class="sub">{_e(report.created_at.replace("T", " ")[:16])} · runtime {t.get("total_s", 0):.0f} s '
        f"(hard {t.get('hard_s', 0):.0f} s, VLM {t.get('soft_s', 0):.0f} s) · lerobot-critics {_e(__version__)}</div>"
        f'<div class="sub">dataset <code>{_e(report.dataset)}</code></div>'
    )


def _overview(report: DatasetReport) -> str:
    c = report.counts
    n = report.n_episodes or len(report.episodes)
    accept, review = _thresholds(report)
    totals = [r.score.total for r in report.episodes if r.score.total is not None]
    med = _median(totals)
    gated = sum(1 for r in report.episodes if r.score.gates_failed)
    usable = _duration(_usable_seconds(report))
    evaluation = purpose_of(report) == "evaluation"
    meaning = verdict_meaning(purpose_of(report))
    tiles = [
        (str(n), "rollouts checked" if evaluation else "episodes checked"),
        (
            str(len(report.include)),
            f"{'successes' if evaluation else 'usable for training'} "
            f"({100 * len(report.include) / n if n else 0:.0f} %)",
        ),
        (usable, "time in successful rollouts" if evaluation else "accepted recording time"),
        (_f(med), "median total score"),
        (str(gated), "rejected by a gate"),
        (str(len(report.flag_counts)), "distinct findings"),
    ]
    kpis = "".join(f'<div class="kpi"><b>{_e(v)}</b><span>{_e(label)}</span></div>' for v, label in tiles)
    legend = "".join(
        f'<div><span class="dot" style="background:{VERDICT_COLOR[v]}"></span>'
        f'<b>{c.get(v, 0)}</b> <span class="mut">{v} — {what}</span></div>'
        for v, what in meaning.items()
    )
    rec = (
        f"The policy succeeded in <b>{len(report.include)} of {n}</b> rollouts "
        f"({100 * len(report.include) / n if n else 0:.0f} %), <b>{len(report.review)}</b> are undecided "
        f"and <b>{len(report.exclude)}</b> failed."
        if evaluation
        else f"Take <b>{len(report.include)} of {n}</b> episodes (~{usable}) into training, "
        f"look at <b>{len(report.review)}</b> and drop <b>{len(report.exclude)}</b>."
    )
    if report.dataset_flags:
        rec += (
            f" {len(report.dataset_flags)} finding(s) concern the whole recording session "
            "(see <i>dataset-level findings</i>) and are not fixed by dropping episodes."
        )
    prof = _profile(report)
    if prof.get("headline"):
        rec += f'</p><p class="rec small mut">{_e(prof["headline"])}'
        rec += " See <i>recording session profile</i>."
    return (
        f'<div class="card"><div class="kpis">{kpis}</div>'
        f'<div class="verdictrow" style="margin-top:14px">'
        f'<div class="donut">{_svg_donut(c, n)}</div>'
        f'<div class="legend">{legend}</div></div>'
        f'<p class="rec">{rec}</p>'
        f'<p class="sub small">Verdict rule: total ≥ {accept:g} → accept, ≥ {review:g} → review, else reject; '
        f"a failed gate rejects regardless of the score, a review flag caps an accept at review.</p></div>"
    )


def _selection(report: DatasetReport) -> str:
    """The three episode lists in full - the one thing a person needs to act on the run."""
    lists = selection_lists(report)
    evaluation = purpose_of(report) == "evaluation"
    keep = lists["accept"]
    cards = []
    for verdict, title, note in (
        (
            ("accept", "Success", "the policy did the task"),
            ("review", "Look at these", "watch the composite video, then decide"),
            ("reject", "Failure", "the task was not done, or a gate fired"),
        )
        if evaluation
        else (
            ("accept", "Keep - train on these", "usable as recorded"),
            ("review", "Look at these", "watch the composite video, then keep or drop"),
            ("reject", "Drop these", "excluded by a gate or a score below the reject threshold"),
        )
    ):
        d = lists[verdict]
        eps = _e(d["ranges"]) if d["episodes"] else "<span class='mut'>none</span>"
        cards.append(
            f'<div><h3><span class="pill {verdict}">{verdict}</span> '
            f'<b>{d["n"]}</b> episodes</h3><p class="sub small">{_e(title)} - {_e(note)}</p>'
            f'<div class="eps">{eps}</div></div>'
        )
    train = keep["episodes"]
    train_review = sorted(train + lists["review"]["episodes"])
    return (
        "<h2>Which episodes to filter</h2>"
        f'<div class="card"><p style="margin:0">Every episode of the run, by verdict. The compact form '
        f"(<code>0-4,7</code>) is what a <code>--episodes</code> filter takes, the block below is the "
        f"same as a Python list.</p>"
        f'<div class="pick">{"".join(cards)}</div>'
        f"<pre># episodes to train on ({len(train)}); the rest is filtered out\n"
        f"include = {_e(repr(train))}\n\n"
        f"# drop ({len(report.exclude)})\n"
        f"exclude = {_e(repr(report.exclude))}\n\n"
        f"# undecided - a person has to look ({len(report.review)})\n"
        f"review  = {_e(repr(report.review))}\n\n"
        f"# include + review, if you accept the review cases after watching them ({len(train_review)})\n"
        f"include_with_review = {_e(repr(train_review))}</pre>"
        f'<p class="sub small">Also written next to this report as <code>selection.json</code>; '
        f"<code>lerobot-critics episodes &lt;run dir&gt; --verdict accept</code> prints the same lists.</p>"
        "</div>"
    )


def _why_filtered(report: DatasetReport) -> str:
    """One row per filtered episode: the decisive cause, the evidence, what to switch off."""
    rows = filtered_episodes(report)
    if not rows:
        return ""
    gate_flags, review_flags = _gate_and_review_flags(report)
    body = []
    for d in rows:
        details = "".join(f"<li>{_e(x)}</li>" for x in d["details"][:4])
        blocking = "".join(
            f'<span class="flag {"gate" if f in gate_flags else "review" if f in review_flags else ""}">'
            f"{_e(f)}</span>"
            for f in d["blocking"]
        )
        other = [f for f in d["flags"] if f not in d["blocking"]]
        others = "".join(f'<span class="flag">{_e(f)}</span>' for f in other)
        decided = blocking or '<span class="mut small">score only</span>'

        body.append(
            f"<tr><td><b>{d['episode']}</b></td>"
            f'<td><span class="pill {d["verdict"]}">{d["verdict"]}</span></td>'
            f"<td>{_f(d['total'])}</td>"
            f'<td class="why"><b>{_e(d["headline"])}</b>'
            + (f"<ul>{details}</ul>" if details else "")
            + "</td>"
            f"<td>{decided}</td>"
            f'<td class="small mut">{others or ""}</td></tr>'
        )
    return (
        f"<h2>Why these {len(rows)} episodes were filtered</h2>"
        '<p class="sub">Every episode that is not accepted, worst first. <i>Decided by</i> is what you would '
        "have to switch off to get the episode back; <i>other findings</i> were recorded but did not filter "
        "anything.</p>"
        '<div class="card"><table><thead><tr><th>ep</th><th>verdict</th><th>total</th>'
        "<th>why it was filtered</th><th>decided by</th><th>other findings</th></tr></thead>"
        f"<tbody>{''.join(body)}</tbody></table></div>"
    )


def _tuning(report: DatasetReport) -> str:
    """Which criteria are worth switching off, with the spec snippet that does it."""
    rows = flag_impact(report)
    if not rows:
        return ""
    decisive = [r for r in rows if r["decides"]]
    if not decisive:
        return ""
    body = []
    for r in decisive:
        gain = impact_text(r)
        back = (
            f"<b>{_e(gain)}</b>"
            if gain
            else '<span class="mut">nothing - those episodes are filtered by their score too</span>'
        )
        note = r["hint"] or r["meaning"]
        body.append(
            f'<tr><td><span class="flag">{_e(r["flag"])}</span></td>'
            f'<td class="small">{_e(r["effect"])}</td>'
            f'<td>{r["n"]}</td><td>{len(r["decides"])}</td><td class="small">{back}</td>'
            f'<td class="small mut">{_e(note)}</td></tr>'
        )
    snippet = tuning_snippet([r for r in decisive if r["would_improve"]] or decisive[:1])
    return (
        "<h2>Criteria you can switch off</h2>"
        '<p class="sub">A finding that does not apply to your setup (an arm that is not used, a fixed object '
        "pose, a protocol without a fixed cycle count) can be muted for the whole dataset. The last column "
        "of the table is a replay of this run with the flag muted, so it is what you would really get "
        "back.</p>"
        '<div class="card"><table><thead><tr><th>finding</th><th>effect on the verdict</th>'
        "<th>episodes</th><th>decides</th><th>if muted</th><th>note</th></tr></thead>"
        f"<tbody>{''.join(body)}</tbody></table>"
        + (
            f'<p class="sub small" style="margin-top:10px">Put this in the spec and re-run - '
            f"muting a flag removes its gate and its review cap, never a critic's score:</p>"
            f"<pre>{_e(snippet)}</pre>"
            if snippet
            else ""
        )
        + "</div>"
    )


def _charts(report: DatasetReport) -> str:
    accept, review = _thresholds(report)
    totals = [r.score.total for r in report.episodes if r.score.total is not None]
    health = _critic_health(report)
    gate_flags, review_flags = _gate_and_review_flags(report)
    flag_rows = [
        (
            f,
            float(k),
            str(k),
            C_REJECT if f in gate_flags else C_REVIEW if f in review_flags else C_ACC,
        )
        for f, k in list(report.flag_counts.items())[:10]
    ]
    out = [
        '<div class="charts">',
        '<div class="chart wide"><h3>Total score per episode</h3>'
        '<p class="sub">In recording order — a trend or a bad stretch of the session is visible here.</p>'
        + _svg_episode_scores(report.episodes, accept, review)
        + "</div>",
    ]
    if totals:
        out.append(
            '<div class="chart"><h3>Score distribution</h3>'
            '<p class="sub">How many episodes fall in each score band.</p>'
            + _svg_histogram(totals, accept, review)
            + "</div>"
        )
    if flag_rows:
        vmax = max(v for _, v, _, _ in flag_rows)
        out.append(
            '<div class="chart"><h3>Most frequent findings</h3>'
            '<p class="sub">Episodes carrying each flag; red = rejects the episode, amber = caps it at review.</p>'
            + _svg_hbars(flag_rows, vmax=vmax, label_w=170)
            + "</div>"
        )
    if health:
        out.append(
            '<div class="chart wide"><h3>Which check is the weak spot</h3>'
            '<p class="sub">Mean critic score over the whole run, worst first (⚑ = episodes this critic '
            "flagged).</p>" + _svg_hbars(health, label_w=200, width=760) + "</div>"
        )
    out.append("</div>")
    return "".join(out)


def _profile(report: DatasetReport) -> dict[str, Any]:
    prof = getattr(report, "session_profile", None) or {}
    if not prof.get("indicators"):
        try:
            prof = build_session_profile(report)
        except Exception:  # noqa: BLE001 - old or partial reports: no profile
            prof = {}
    return prof


def _ind_card(i: dict[str, Any]) -> str:
    unit = i.get("unit") or ""
    val = _e(str(i.get("display", "–")))
    xtra = i.get("display_extra")
    spread = ""
    if i.get("n", 0) > 1 and i.get("low") is not None and i.get("high") is not None and not xtra:
        spread = f"{_f(i['low'], 1)} – {_f(i['high'], 1)} {unit} across {i['n']} episodes"
    thr = ""
    if i.get("good") is not None and i.get("bad") is not None and i.get("better") in ("lower", "higher"):
        rel = "≤" if i["better"] == "lower" else "≥"
        rel_b = "≥" if i["better"] == "lower" else "≤"
        thr = f"good {rel} {i['good']:.3g}, bad {rel_b} {i['bad']:.3g} {unit}".strip()
    txt = i.get("so_what") or i.get("what") or ""
    act = i.get("action") or ""
    show_act = act and i.get("status") in ("warn", "bad")
    return (
        f'<div class="ind {i.get("status", "info")}">'
        f'<div class="lbl">{_e(i["label"])}<span class="stat {i.get("status", "info")}">{_e(i.get("status", "info"))}</span></div>'
        f'<div class="val">{val}<small>{_e(unit)}</small></div>'
        + (f'<div class="xtra">{_e(str(xtra))}</div>' if xtra else "")
        + (f'<div class="xtra">{_e(spread)}</div>' if spread else "")
        + (f'<div class="txt">{_e(txt)}</div>' if txt else "")
        + (f'<div class="act"><b>What to do:</b> {_e(act)}</div>' if show_act else "")
        + (f'<div class="thr">{_e(thr)}</div>' if thr else "")
        + "</div>"
    )


def _session_profile(report: DatasetReport) -> str:
    prof = _profile(report)
    inds = prof.get("indicators") or []
    if not inds:
        return ""
    by = {i["id"]: i for i in inds}
    counts = prof.get("status_counts") or {}
    cls = "bad" if counts.get("bad") else "warn" if counts.get("warn") else "good"
    out = [
        '<div class="pagebreak"></div><h2>Recording session profile</h2>',
        '<p class="sub">The physical properties of the session, aggregated over the evaluated episodes (median per '
        "indicator, thresholds from the spec). These numbers say what to change at the rig, the teleop and the "
        "protocol before the next recording day - the episode verdicts below say what to drop from this one.</p>",
        f'<p class="headline {cls}">{_e(prof.get("headline", ""))}</p>',
    ]
    for g, items in indicators_by_group(prof):
        if not items:
            continue
        out.append(
            f'<div class="group"><h3>{_e(g["title"])}</h3><p class="sub">{_e(g["intro"])}</p>'
            f'<div class="inds">{"".join(_ind_card(i) for i in items)}</div></div>'
        )
    # charts: latency and tremor per episode, grasp positions top view, camera table
    charts: list[str] = []
    lag = by.get("latency_ms")
    if lag and lag.get("series"):
        charts.append(
            '<div class="chart wide"><h3>Teleop latency per episode</h3>'
            '<p class="sub">Command → robot delay from the velocity cross-correlation, in ms. A stable controller gives a '
            "flat line; scatter between episodes points at variable buffering in the teleop chain.</p>"
            + _svg_series(lag["series"], lag.get("good"), lag.get("bad"), "lower", "ms")
            + "</div>"
        )
    trem = by.get("tremor_cmd")
    if trem and trem.get("series"):
        charts.append(
            '<div class="chart wide"><h3>Tremor: command vs. robot state per episode</h3>'
            '<p class="sub">Share of velocity power above 5 Hz. Wide bar = the operator\'s command, dark bar = what the '
            "robot actually did. A command bar far above the robot bar means the input device shakes and the "
            "controller filters it - the policy is trained on the shaking command.</p>"
            + _svg_series(
                trem["series"],
                trem.get("good"),
                trem.get("bad"),
                "lower",
                "%",
                second=trem.get("state_series"),
            )
            + "</div>"
        )
    pts = prof.get("grasp_points") or []
    spread = by.get("grasp_spread_cm")
    scatter = _svg_scatter(pts, spread.get("value") if spread else None) if len(pts) >= 2 else ""
    cams = prof.get("cameras") or []
    right = ""
    if cams:
        rows = "".join(
            f"<tr><td><code>{_e(c['short'])}</code></td><td>{_f(c.get('brightness'), 0)}</td>"
            f"<td>{_f(100 * c['clip_high'], 1) if c.get('clip_high') is not None else '–'} %</td>"
            f"<td>{_f(100 * c['clip_low'], 1) if c.get('clip_low') is not None else '–'} %</td>"
            f"<td>{_f(c.get('sharpness_p10'), 0)}</td>"
            f"<td>{_f(100 * c['dup_rate'], 0) if c.get('dup_rate') is not None else '–'} %</td></tr>"
            for c in cams
        )
        right = (
            '<div class="chart"><h3>Cameras</h3>'
            '<p class="sub">Median over the run. Brightness 0–255; blown-out / black = share of clipped pixels '
            "(glare, back-light); sharpness = Laplacian variance, higher is crisper; repeats = duplicated consecutive "
            "frames (effective frame rate).</p>"
            "<table><thead><tr><th>camera</th><th>brightness</th><th>blown-out</th><th>black</th><th>sharpness</th>"
            f"<th>repeats</th></tr></thead><tbody>{rows}</tbody></table></div>"
        )
    if scatter:
        charts.append(
            '<div class="chart"><h3>Where the object was grasped</h3>'
            '<p class="sub">Top view of the wrist position at every grasp of the run (cm). The dashed square is '
            "5 cm wide - if all grasps fit inside it, the policy has seen one object position.</p>"
            + scatter
            + "</div>"
        )
    if right:
        charts.append(right)
    if charts:
        out.append(f'<div class="charts">{"".join(charts)}</div>')
    return "".join(out)


def _dataset_findings(report: DatasetReport) -> str:
    if not report.dataset_flags:
        return ""
    rows = "".join(
        f'<tr><td><span class="flag gate">{_e(f)}</span></td><td>{_e(why)}</td>'
        f'<td class="mut">{_e(flag_action(f, purpose_of(report)))}</td></tr>'
        for f, why in report.dataset_flags.items()
    )
    return (
        "<h2>Dataset-level findings</h2>"
        '<div class="card"><p class="sub" style="margin-top:0">Properties of the whole recording session. '
        "They do not change any verdict — no single episode is at fault — but they limit what a policy can "
        "learn from this dataset.</p>"
        f"<table><thead><tr><th>finding</th><th>what was measured</th><th>what to do</th></tr></thead>"
        f"<tbody>{rows}</tbody></table></div>"
    )


def _findings_table(report: DatasetReport, limit: int) -> str:
    rows = _finding_rows(report, limit)
    if not rows:
        return ""
    body = []
    for d in rows:
        eps = d["episodes"]
        shown = ", ".join(str(e) for e in eps[:14]) + (f" … (+{len(eps) - 14})" if len(eps) > 14 else "")
        cls = "gate" if d["severity"] == "gate" else "review" if d["severity"] == "review" else ""
        body.append(
            f'<tr><td><span class="flag {cls}">{_e(d["flag"])}</span></td>'
            f"<td><b>{len(eps)}</b></td><td>{_e(d['meaning'])}</td>"
            f'<td class="mut">{_e(d["action"])}</td><td class="small mut">{_e(shown)}</td></tr>'
        )
    return (
        f"<h2>Top {len(rows)} findings of the run</h2>"
        '<p class="sub">Ordered by severity: findings that reject an episode first, then those that force '
        "a review, then the informational ones.</p>"
        '<div class="card"><table><thead><tr><th>flag</th><th>episodes</th><th>what it means</th>'
        "<th>what to do</th><th>affected</th></tr></thead>"
        f"<tbody>{''.join(body)}</tbody></table></div>"
    )


def _metric_line(c: CriticResult, max_keys: int = 8, max_chars: int = 320) -> str:
    """The critic's telling numbers as ``key=value`` pairs: scalars only, no repeats, whole items.

    Critics emit an aggregate and a per-feature copy of the same number (``ldj_median`` and
    ``ldj_median.action.arm``); zeros and duplicates crowd out what actually explains the score.
    """
    items: list[tuple[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for k, v in c.metrics.items():
        if k.startswith(("_", "z.")) or not isinstance(v, (int, float, bool, str)):
            continue
        key = (k.split(".")[0], _metric_value(v))
        if key in seen:
            continue
        seen.add(key)
        items.append((k, v))
    informative = [(k, v) for k, v in items if isinstance(v, bool) or isinstance(v, str) or v != 0]
    parts = [f"{k}={_metric_value(v)}" for k, v in (informative or items)[:max_keys]]
    line = ""
    for part in parts:
        if line and len(line) + len(part) + 2 > max_chars:
            return line + ", …"
        line = f"{line}, {part}" if line else part
    return line


def _indicator_descriptions(report: DatasetReport) -> dict[str, str]:
    """``vlm.<id>`` -> what the spec asked the VLM to judge (soft critics carry no evidence of their own)."""
    out = {}
    for ind in (_spec(report).get("soft_critics") or {}).get("indicators") or []:
        if isinstance(ind, dict) and ind.get("id"):
            out[f"vlm.{ind['id']}"] = str(ind.get("description") or "")
    return out


def _episode_card(report: DatasetReport, r: EpisodeReport, out_dir: Path | None, embed_images: bool) -> str:
    gate_flags, review_flags = _gate_and_review_flags(report)
    indicators = _indicator_descriptions(report)
    flags = "".join(
        f'<span class="flag {"gate" if f in gate_flags else "review" if f in review_flags else ""}">{_e(f)}</span>'
        for f in r.score.flags
    )
    head = (
        f'<div class="head"><span class="num">Episode {r.episode}</span>'
        f'<span class="pill {r.score.verdict}">{r.score.verdict}</span>'
        f'<span class="mut small">total {_f(r.score.total)} '
        f"(hard {_f(r.score.hard_score)} / soft {_f(r.score.soft_score)}) · "
        f"{r.duration_s:.1f} s / {r.length} frames</span></div>"
    )
    parts = [head, f"<div>{flags}</div>" if flags else ""]
    if r.score.gates_failed:
        parts.append(
            f'<p class="small" style="color:var(--bad);margin:6px 0 0">rejected by gate: '
            f"<b>{_e(', '.join(r.score.gates_failed))}</b></p>"
        )
    for c in _weak_critics(r):
        pct = 0 if c.score is None else round(100 * c.score)
        metrics = _metric_line(c)
        top = (
            f'<div class="top"><code>{_e(c.id.replace("vlm.", "vlm:"))}</code>'
            f'<span class="bar"><i style="width:{pct}%;background:{_score_color(c.score)}"></i></span>'
            f'<span class="small mut">{_f(c.score)}</span>'
            + ('<span class="flag gate">GATE</span>' if c.gate_failed else "")
            + "".join(f'<span class="flag">{_e(f)}</span>' for f in c.flags)
            + "</div>"
        )
        evidence = "".join(f'<div class="small">{_e(e)}</div>' for e in c.evidence[:3])
        if not c.evidence and indicators.get(c.id):
            evidence = f'<div class="small mut">judged: {_e(indicators[c.id])}</div>'
        if c.error:
            evidence += f'<div class="small" style="color:var(--bad)">{_e(c.error)}</div>'
        mline = f'<div class="metrics">{_e(metrics)}</div>' if metrics else ""
        parts.append(f'<div class="critic">{top}{evidence}{mline}</div>')
    summ = next((s for s in r.soft if s.id == "vlm.summary"), None)
    if summ is not None and (summ.evidence or summ.error):
        m = summ.metrics or {}
        anomalies = "".join(
            f"<li><b>{_e(str(a.get('type', '?')))}</b> @ {_f(a.get('time_s'), 1)} s "
            f'<span class="mut">({_e(str(a.get("severity", "")))})</span> — {_e(str(a.get("description", "")))}</li>'
            for a in (m.get("anomalies") or [])[:4]
            if isinstance(a, dict)
        )
        text = summ.error or (summ.evidence[0] if summ.evidence else "")
        parts.append(
            '<div class="critic"><div class="top"><code>vlm judge</code>'
            f'<span class="small mut">task_success = {_e(str(m.get("task_success")))}</span></div>'
            f'<div class="small">{_e(str(text))}</div>'
            + (f'<ul class="why small">{anomalies}</ul>' if anomalies else "")
            + "</div>"
        )
    if embed_images:
        uri = _sheet_data_uri(out_dir, r.episode)
        if uri:
            parts.append(
                f'<img src="{uri}" alt="contact sheet of episode {r.episode}">'
                '<div class="sub small">Contact sheet: evenly spaced frames plus the grasp keyframes, '
                "one row per camera.</div>"
            )
    return f'<div class="ep">{"".join(parts)}</div>'


def _glossary(report: DatasetReport, shown: list[EpisodeReport], limit: int) -> str:
    flags = {d["flag"] for d in _finding_rows(report, limit)} | {f for r in shown for f in r.score.flags}
    if not flags:
        return ""
    gate_flags, review_flags = _gate_and_review_flags(report)
    rows = "".join(
        f'<tr><td><span class="flag {"gate" if f in gate_flags else "review" if f in review_flags else ""}">'
        f"{_e(f)}</span></td><td>{_e(flag_meaning(f))}</td></tr>"
        for f in sorted(flags)
    )
    return (
        "<h2>Flag glossary</h2>"
        f'<div class="card"><table><thead><tr><th>flag</th><th>meaning</th></tr></thead>'
        f"<tbody>{rows}</tbody></table></div>"
    )


def _how_to_read(report: DatasetReport) -> str:
    accept, review = _thresholds(report)
    spec = _spec(report)
    per_ep = _per_episode_tasks(report)
    task = (
        f"per episode, from the dataset ({len(per_ep)} distinct instructions)"
        if per_ep
        else ((spec.get("task") or {}).get("instruction") or "")
    )
    hard = ", ".join(f"<code>{_e(str(c.get('id')))}</code>" for c in (spec.get("hard_critics") or []))
    soft = ", ".join(
        f"<code>{_e(str(i.get('id')))}</code>"
        for i in ((spec.get("soft_critics") or {}).get("indicators") or [])
    )
    muted = ", ".join(
        f"<code>{_e(str(f))}</code>" for f in ((spec.get("scoring") or {}).get("ignore_flags") or [])
    )
    return (
        "<h2>How to read this report</h2>"
        '<div class="card">'
        + (f"<p><b>Task:</b> {_e(task)}</p>" if task else "")
        + "<p>Every critic scores an episode in <b>[0, 1]</b> (1 = good). <i>Hard</i> critics are "
        "deterministic checks on the recorded signals and video; <i>soft</i> critics are task-success "
        "indicators judged by a vision-language model from the episode video. <code>total</code> is the "
        "weighted mean of the two group scores; the verdict follows from it "
        f"(≥ {accept:g} accept, ≥ {review:g} review, else reject), except that a failed <b>gate</b> rejects "
        "an episode outright and a <b>review flag</b> caps an otherwise accepted episode at review. "
        "<code>*_OUTLIER</code> flags only say that an episode differs from the rest of this run.</p>"
        + (
            f'<p class="sub">Findings switched off for this dataset '
            f"(<code>scoring.ignore_flags</code>): {muted}</p>"
            if muted
            else ""
        )
        + (f'<p class="sub">Hard critics in this run: {hard}</p>' if hard else "")
        + (f'<p class="sub">VLM indicators: {soft}</p>' if soft else "")
        + "</div>"
    )


def _artifacts(report: DatasetReport, asset_base: str, shown: list[EpisodeReport]) -> str:
    files = [
        "report.md",
        "report_ai.md",
        "report.json",
        "episodes.csv",
        "episodes_columns.csv",
        "selection.json",
    ]
    links = " · ".join(f'<a href="{_e(asset_base + f)}">{_e(f)}</a>' for f in files)
    vids = " · ".join(
        f'<a href="{_e(asset_base)}composites/episode_{r.episode:06d}.mp4">episode {r.episode}</a>'
        for r in shown
    )
    return (
        f'<div class="footer">Full data next to this report: {links}. '
        + (f"Composite videos of the episodes above: {vids}. " if vids else "")
        + "For an AI assistant, hand over <code>report_ai.md</code> or use “Copy as Markdown” in the UI.</div>"
    )


def render_html_report(
    report: DatasetReport,
    out_dir: Path | None = None,
    top_n: int = 5,
    asset_base: str = "",
    embed_images: bool = True,
) -> str:
    """Render a run as a single self-contained, printable HTML document.

    ``out_dir`` is the run's output directory; its contact sheets are embedded into the
    document (``embed_images``). ``top_n`` bounds both the findings table and the number of
    episodes analysed in detail - the report stays a handful of pages regardless of dataset
    size. ``asset_base`` is prefixed to the links of the run's other artifacts (``""`` when
    the file sits in the output directory, ``/jobs/{id}/files/`` when the API serves it).
    """
    top_n = max(1, int(top_n))
    accept, _review = _thresholds(report)
    conspicuous = [
        r
        for r in sorted(report.episodes, key=_severity_key)
        if r.score.verdict != "accept"
        or r.score.flags
        or (r.score.total is not None and r.score.total < accept)
        or r.error
    ]
    worst = conspicuous[:top_n]
    if worst:
        detail = (
            f"<h2>Detail analysis: top {len(worst)} episodes</h2>"
            '<p class="sub">The most conspicuous episodes: failed gates first, then rejects and reviews, '
            "then the lowest scores.</p>"
            + "".join(_episode_card(report, r, out_dir, embed_images) for r in worst)
        )
    else:
        detail = (
            '<h2>Detail analysis</h2><div class="card"><p style="margin:0">No episode was gated, rejected '
            "or flagged - there is nothing to analyse in detail.</p></div>"
        )
    body = (
        _header(report)
        + '<div class="noprint" style="margin:12px 0"><button onclick="window.print()">Print / Save as PDF</button>'
        '<span class="sub" style="margin-left:10px">prints to A4</span></div>'
        + _overview(report)
        + _selection(report)
        + _charts(report)
        + _session_profile(report)
        + _dataset_findings(report)
        + _findings_table(report, top_n)
        + '<div class="pagebreak"></div>'
        + _why_filtered(report)
        + _tuning(report)
        + detail
        + _how_to_read(report)
        + _glossary(report, worst, top_n)
        + _artifacts(report, asset_base, worst)
    )
    return (
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>Critic report · {_e(report.dataset_name)}</title>"
        f'<style>{CSS}</style></head><body><div class="doc">{body}</div></body></html>\n'
    )


def write_html_report(report: DatasetReport, out_dir: Path, top_n: int = 5) -> Path:
    """Write ``report.html`` into a run's output directory."""
    path = out_dir / "report.html"
    path.write_text(render_html_report(report, out_dir=out_dir, top_n=top_n), encoding="utf-8")
    return path
