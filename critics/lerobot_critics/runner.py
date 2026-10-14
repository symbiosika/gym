"""Orchestrates critics over a dataset: hard critics in a process pool, VLM judge in a
thread pool, then dataset-level finalization, scoring and report writing."""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import time
import traceback
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import BaseModel, Field

from .critics.base import CriticResult, _jsonable
from .critics.registry import build_hard_critics
from .dataset.loader import LeRobotDataset, open_dataset
from .metrics_doc import docs_for_metrics
from .scoring import EpisodeScore, aggregate
from .spec.models import CriticSpec

ProgressCb = Callable[[str, int, int], None]


class RunOptions(BaseModel):
    episodes: list[int] | None = None
    max_episodes: int | None = Field(
        None,
        ge=1,
        description="analyse at most this many episodes, spread evenly over the dataset (a sample); "
        "applied after `episodes`. None = all.",
    )
    out_dir: str = "critic_out"
    workers: int = Field(0, description="process workers for hard critics; 0 = cpu count")
    run_hard: bool = True
    run_soft: bool = True
    contact_sheets: bool = True
    include_episodes: list[int] | None = Field(
        None,
        description="episodes analysed in addition to the sample (`max_episodes`): ones a person "
        "picked by number",
    )
    sheets_for_all: bool = Field(
        False,
        description="write a contact sheet for every episode, not only for the ones not accepted "
        "(a sample someone looks through to write a spec)",
    )


def sample_episodes(eps: list[int], n: int | None) -> list[int]:
    """At most ``n`` of ``eps``, spread evenly from the first to the last, in order.

    A sample of a recording session should see its start, its middle and its end:
    an operator tires, a camera drifts, the scene changes over a session, and the
    first ``n`` episodes would show none of that.
    """
    if n is None or len(eps) <= n:
        return list(eps)
    if n == 1:
        return [eps[0]]
    step = (len(eps) - 1) / (n - 1)
    return [eps[round(i * step)] for i in range(n)]


def parse_episodes(s: str | None) -> list[int] | None:
    """``"0,3,7-9"`` -> ``[0, 3, 7, 8, 9]``; empty/None -> None (= all episodes)."""
    if not s or not s.strip():
        return None
    out: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return out


class EpisodeReport(BaseModel):
    episode: int
    task: str = ""
    length: int = 0
    duration_s: float = 0.0
    hard: list[CriticResult] = Field(default_factory=list)
    soft: list[CriticResult] = Field(default_factory=list)
    score: EpisodeScore
    keyframes: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class DatasetReport(BaseModel):
    dataset: str
    dataset_name: str
    spec_name: str
    spec: dict[str, Any]
    created_at: str
    robot_type: str = ""
    fps: float = 0.0
    cameras: list[str] = Field(default_factory=list)
    n_episodes: int = 0
    # the episodes the dataset holds; more than n_episodes when the run looked at a sample
    dataset_episodes: int = 0
    counts: dict[str, int] = Field(default_factory=dict)
    include: list[int] = Field(default_factory=list)
    review: list[int] = Field(default_factory=list)
    exclude: list[int] = Field(default_factory=list)
    flag_counts: dict[str, int] = Field(default_factory=dict)
    dataset_stats: dict[str, Any] = Field(default_factory=dict)
    # run-level findings from HardCritic.summarize(): {critic id: summary dict}
    dataset_summaries: dict[str, dict[str, Any]] = Field(default_factory=dict)
    # run-level flags with their explanation (LOW_DIVERSITY, STATS_RANGE_INFLATED, ...)
    dataset_flags: dict[str, str] = Field(default_factory=dict)
    # what/how documentation of every metric key that occurs in this run ({"critic.key": doc})
    metric_docs: dict[str, dict[str, Any]] = Field(default_factory=dict)
    # what every flag raised in this run means, in one sentence ({"CAMSTALL": "camera frames ..."})
    flag_docs: dict[str, str] = Field(default_factory=dict)
    # recording-session profile: latency, tremor, grasp behaviour, diversity, hygiene (session_profile.py)
    session_profile: dict[str, Any] = Field(default_factory=dict)
    timing_s: dict[str, float] = Field(default_factory=dict)
    # what a person changed after the run (selection.apply_overrides): flags in
    # ``review_flags`` only cap an episode at review instead of rejecting it, flags in
    # ``ignore_flags`` are informational, critics in ``disabled_critics`` do not count at
    # all. The critic results stay as they were raised; only the verdicts are replayed, so
    # an override can be taken back.
    overrides: dict[str, list[str]] = Field(default_factory=dict)
    episodes: list[EpisodeReport] = Field(default_factory=list)


# ------------------------------------------------------------------ workers
def _hard_worker(args: tuple) -> dict[str, Any]:
    ds_path, spec_dict, ep_index, out_dir, composite = args
    spec = CriticSpec.model_validate(spec_dict)
    ds = open_dataset(ds_path)
    ep = ds.episode(ep_index)
    t0 = time.time()
    try:
        if composite:
            from .critics.soft.vlm import ensure_composite

            ensure_composite(
                ep,
                spec,
                Path(out_dir),
                spec.soft_critics.vlm.composite_fps,
                spec.soft_critics.vlm.composite_scale,
            )
        results = [c.safe_evaluate(ep) for c in build_hard_critics(spec)]
        gc = ep.cache.get("grasp_cycles") or {}
        return {
            "episode": ep_index,
            "task": ep.task,
            "length": ep.length,
            "duration_s": ep.duration_s,
            "hard": [r.model_dump() for r in results],
            "keyframes": {
                "grasp": [c["grasp"] for c in gc.get("cycles", [])],
                "release": [c["release"] for c in gc.get("cycles", [])],
            },
            "scan": ep.cache.get("scan"),
            "t": time.time() - t0,
        }
    except Exception as e:  # noqa: BLE001
        return {
            "episode": ep_index,
            "error": f"{type(e).__name__}: {e}\n{traceback.format_exc()}",
            "t": time.time() - t0,
        }


def _soft_worker(
    judge, ds: LeRobotDataset, ep_index: int, keyframes: dict
) -> tuple[int, list[dict], str | None]:
    ep = ds.episode(ep_index)
    if keyframes.get("grasp"):
        ep.cache["grasp_cycles"] = {
            "cycles": [
                {"grasp": g, "release": r}
                for g, r in zip(keyframes["grasp"], keyframes["release"], strict=False)
            ]
        }
    try:
        _, results = judge.judge(ep)
        return ep_index, [r.model_dump() for r in results], None
    except Exception as e:  # noqa: BLE001
        return ep_index, [], f"{type(e).__name__}: {e}"


# ------------------------------------------------------------------ main entry
def run(
    dataset_path: str | Path,
    spec: CriticSpec,
    options: RunOptions | None = None,
    progress: ProgressCb | None = None,
) -> DatasetReport:
    options = options or RunOptions()
    t_start = time.time()
    ds = open_dataset(dataset_path)
    out_dir = Path(options.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    eps = options.episodes if options.episodes is not None else ds.episode_indices()
    eps = [e for e in eps if e in ds.episodes]
    eps = sample_episodes(eps, options.max_episodes)
    if options.include_episodes:
        eps = sorted(set(eps) | {e for e in options.include_episodes if e in ds.episodes})
    spec_dict = json.loads(spec.model_dump_json())
    soft_on = options.run_soft and spec.soft_critics.enabled and spec.soft_critics.vlm.provider != "none"
    composite = (
        soft_on
        and spec.soft_critics.vlm.mode in ("agentic", "static")
        and spec.soft_critics.vlm.provider == "gemini"
    )

    def _progress(stage: str, done: int, total: int) -> None:
        if progress:
            progress(stage, done, total)

    # ---- hard critics (process pool)
    per_ep: dict[int, dict[str, Any]] = {}
    timing: dict[str, float] = {}
    t0 = time.time()
    if options.run_hard or composite:
        workers = options.workers or max(1, os.cpu_count() or 2)
        workers = min(workers, len(eps)) or 1
        jobs = [(str(ds.root), spec_dict, e, str(out_dir), composite) for e in eps]
        done = 0
        _progress("hard", 0, len(eps))
        if workers == 1:
            for j in jobs:
                r = _hard_worker(j)
                per_ep[r["episode"]] = r
                done += 1
                _progress("hard", done, len(eps))
        else:
            # never fork() a multi-threaded process (the API runs jobs in threads): forkserver/spawn are safe
            ctx = mp.get_context("forkserver" if "forkserver" in mp.get_all_start_methods() else "spawn")
            with ProcessPoolExecutor(max_workers=workers, mp_context=ctx) as pool:
                for r in pool.map(_hard_worker, jobs):
                    per_ep[r["episode"]] = r
                    done += 1
                    _progress("hard", done, len(eps))
    timing["hard_s"] = time.time() - t0

    # ---- soft critics (threads, network bound)
    t0 = time.time()
    soft_results: dict[int, list[dict]] = {}
    soft_errors: dict[int, str] = {}
    if soft_on:
        from .critics.soft.vlm import VLMJudge

        judge = VLMJudge(spec, out_dir)
        conc = max(1, spec.soft_critics.vlm.max_concurrency)
        done = 0
        _progress("soft", 0, len(eps))
        with ThreadPoolExecutor(max_workers=conc) as pool:
            futs = [
                pool.submit(_soft_worker, judge, ds, e, (per_ep.get(e) or {}).get("keyframes", {}))
                for e in eps
            ]
            for f in as_completed(futs):
                e, res, err = f.result()
                soft_results[e] = res
                if err:
                    soft_errors[e] = err
                done += 1
                _progress("soft", done, len(eps))
    timing["soft_s"] = time.time() - t0

    # ---- assemble, finalize (dataset-relative flags), score
    hard_by_id: dict[str, list[CriticResult]] = {}
    reports: list[EpisodeReport] = []
    for e in eps:
        info = per_ep.get(e, {})
        hard = [CriticResult.model_validate(h) for h in info.get("hard", [])] if options.run_hard else []
        soft = [CriticResult.model_validate(s) for s in soft_results.get(e, [])]
        if soft_errors.get(e):
            soft.append(CriticResult(id="vlm.summary", kind="soft", weight=0.0, error=soft_errors[e]))
        for h in hard:
            hard_by_id.setdefault(h.id, []).append(h)
        reports.append(
            EpisodeReport(
                episode=e,
                task=info.get("task", ds.task_for(e)),
                length=info.get("length", ds.episodes[e].length),
                duration_s=info.get("duration_s", ds.episodes[e].length / ds.fps),
                hard=hard,
                soft=soft,
                score=EpisodeScore(episode=e),
                keyframes=info.get("keyframes", {}),
                error=info.get("error"),
            )
        )
    summaries: dict[str, dict[str, Any]] = {}
    dataset_flags: dict[str, str] = {}
    if options.run_hard:
        for critic in build_hard_critics(spec):
            lst = hard_by_id.get(critic.id)
            if not lst:
                continue
            if spec.scoring.relative_flags:
                critic.finalize(lst, spec.scoring.z_cut)
            critic.ds = ds  # type: ignore[attr-defined]
            try:
                summ = critic.summarize(lst)
            except Exception as e:  # noqa: BLE001 - a summary must not kill the run
                summ = {"error": f"{type(e).__name__}: {e}"}
            if summ:
                fl = summ.pop("flags", None) or {}
                if isinstance(fl, dict):
                    ignored = set(spec.scoring.ignore_flags)
                    dataset_flags.update({str(k): str(v) for k, v in fl.items() if str(k) not in ignored})
                summaries[critic.id] = _jsonable(summ)
    for rep in reports:
        rep.score = aggregate(rep.episode, rep.hard, rep.soft, spec.scoring)
        if rep.error:
            rep.score.verdict = "review"
            rep.score.reasons.insert(0, f"critic run failed: {rep.error.splitlines()[0]}")

    counts = {"accept": 0, "review": 0, "reject": 0}
    flag_counts: dict[str, int] = {}
    for rep in reports:
        counts[rep.score.verdict] += 1
        for f in rep.score.flags:
            flag_counts[f] = flag_counts.get(f, 0) + 1
    report = DatasetReport(
        dataset=str(ds.root),
        dataset_name=ds.root.name,
        spec_name=spec.name,
        spec=spec_dict,
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        robot_type=ds.robot_type,
        fps=ds.fps,
        cameras=ds.camera_keys,
        n_episodes=len(reports),
        dataset_episodes=len(ds.episodes),
        counts=counts,
        include=[r.episode for r in reports if r.score.verdict == "accept"],
        review=[r.episode for r in reports if r.score.verdict == "review"],
        exclude=[r.episode for r in reports if r.score.verdict == "reject"],
        flag_counts=dict(sorted(flag_counts.items(), key=lambda kv: -kv[1])),
        dataset_stats=_dataset_stats(reports, per_ep),
        dataset_summaries=summaries,
        dataset_flags=dataset_flags,
        metric_docs=docs_for_metrics(present_metrics(reports)),
        flag_docs=flag_docs_for(reports, dataset_flags),
        timing_s={**timing, "total_s": time.time() - t_start},
        episodes=reports,
    )
    from .report import write_reports
    from .session_profile import build_session_profile

    try:
        # empty for an evaluation: rollouts have no recording session to profile
        report.session_profile = _jsonable(build_session_profile(report))
    except Exception as e:  # noqa: BLE001 - the profile is derived; never fail the run over it
        report.session_profile = {"error": f"{type(e).__name__}: {e}"}
    write_reports(report, out_dir, ds if options.contact_sheets else None, all_sheets=options.sheets_for_all)
    return report


def flag_docs_for(reports: list[EpisodeReport], dataset_flags: dict[str, str]) -> dict[str, str]:
    """The meaning of every flag the run raised: on an episode, by any critic, or on the run."""
    from .ai_report import flag_meaning

    flags = {f for r in reports for c in r.hard + r.soft for f in c.flags} | set(dataset_flags)
    return {f: dataset_flags.get(f) or flag_meaning(f) for f in sorted(flags)}


def present_metrics(reports: list[EpisodeReport]) -> dict[str, set[str]]:
    """``{critic id: {metric keys}}`` over all episodes (private ``_`` keys excluded)."""
    out: dict[str, set[str]] = {}
    for rep in reports:
        for h in rep.hard:
            out.setdefault(h.id, set()).update(k for k in h.metrics if not k.startswith("_"))
    return out


def _dataset_stats(reports: list[EpisodeReport], per_ep: dict[int, dict]) -> dict[str, Any]:
    """Rig-level statistics: medians of key metrics across episodes."""
    keys = [
        "duration_s",
        "pos_err_mean_mm",
        "lag_ms",
        "video_dup_rate_max",
        "action_dup_rate",
        "ldj_median",
        "hf_ratio",
        "hf5_share_cmd",
        "hf5_share_state",
        "hold_rms_speed_cmd_mms",
        "tremor_peak_hz_cmd",
        "idle_arm_path_m_per_min",
        "zero_frames",
        "n_cycles",
        "close_dur_median_s",
        "wrist_move_during_close_median_mm",
        "active_frac",
    ]
    vals: dict[str, list[float]] = {k: [] for k in keys}
    cam_dup: dict[str, list[float]] = {}
    cam_bright: dict[str, list[float]] = {}
    for rep in reports:
        for h in rep.hard:
            for k in keys:
                v = h.metrics.get(k)
                if isinstance(v, (int, float)):
                    vals[k].append(float(v))
            for k, v in h.metrics.items():
                if k.startswith("video_dup_rate.") and isinstance(v, (int, float)):
                    cam_dup.setdefault(k.split(".", 1)[1], []).append(float(v))
                if k.startswith("brightness.") and isinstance(v, (int, float)):
                    cam_bright.setdefault(k.split(".", 1)[1], []).append(float(v))
    out: dict[str, Any] = {}
    for k, v in vals.items():
        if v:
            out[f"{k}.median"] = float(np.median(v))
            out[f"{k}.min"] = float(np.min(v))
            out[f"{k}.max"] = float(np.max(v))
    out["camera_dup_rate_median"] = {c: float(np.median(v)) for c, v in cam_dup.items()}
    out["camera_brightness_median"] = {c: float(np.median(v)) for c, v in cam_bright.items()}
    soft_tokens = [
        s.metrics.get("usage", {}).get("total_tokens")
        for rep in reports
        for s in rep.soft
        if s.id == "vlm.summary" and isinstance(s.metrics.get("usage"), dict)
    ]
    soft_tokens = [t for t in soft_tokens if isinstance(t, (int, float))]
    if soft_tokens:
        out["vlm_total_tokens"] = int(sum(soft_tokens))
        out["vlm_tokens_per_episode_median"] = float(np.median(soft_tokens))
    return out
