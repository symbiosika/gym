"""tremor / normalization / diversity critics, the grasp profile and lag metrics, and the
metric documentation that every emitted metric must have."""

from __future__ import annotations

import csv
import json

import numpy as np

from lerobot_critics.critics import build_hard_critics
from lerobot_critics.critics.hard._util import band_share, welch_psd, xcorr_lag
from lerobot_critics.dataset import open_dataset
from lerobot_critics.metrics_doc import all_metric_docs, describe_metric, undocumented_metrics
from lerobot_critics.runner import RunOptions, present_metrics, run
from lerobot_critics.spec.defaults import default_hard_critics


def _results(ds, spec, ep_index):
    ep = ds.episode(ep_index)
    return {c.id: c.safe_evaluate(ep) for c in build_hard_critics(spec)}


def test_xcorr_lag_recovers_a_known_delay():
    t = np.arange(600) / 30.0
    x = np.sin(2 * np.pi * 0.4 * t) + 0.3 * np.sin(2 * np.pi * 1.1 * t)
    v = np.diff(x)
    delayed = np.concatenate([np.zeros(6), v[:-6]])
    lag, corr = xcorr_lag(v, delayed, 20)
    assert abs(lag - 6.0) < 0.1 and corr > 0.99
    assert xcorr_lag(np.zeros(100), np.zeros(100), 10) is None


def test_welch_band_share_sees_a_10hz_tremor():
    rng = np.random.default_rng(1)
    t = np.arange(900) / 30.0
    slow = np.sin(2 * np.pi * 0.3 * t)
    tremor = 1.0 * np.sin(2 * np.pi * 10.0 * t) + 0.01 * rng.standard_normal(len(t))
    f, p_clean = welch_psd(slow, 30.0)
    f2, p_trem = welch_psd(slow + tremor, 30.0)
    assert band_share(f, p_clean, 5.0) < 0.05
    assert band_share(f2, p_trem, 5.0) > 0.4


def test_default_spec_runs_new_critics(synthetic_dataset, spec):
    spec.hard_critics = default_hard_critics()
    ds = open_dataset(synthetic_dataset)
    res = _results(ds, spec, 0)
    for cid in ("tremor", "normalization", "diversity"):
        assert cid in res and res[cid].error is None, res[cid]
    tr = res["tremor"]
    # the synthetic trajectory is a clean sine: no tremor, no flags
    assert tr.score is not None and tr.score > 0.8, tr.metrics
    assert "TREMOR" not in tr.flags
    assert tr.metrics["tremor_source"] in ("none", "input_device", "robot", "mixed")
    assert "hf5_share_cmd" in tr.metrics and "hold_segments" in tr.metrics
    # normalization: clean data, no zero frames, no idle arms configured
    nz = res["normalization"]
    assert nz.score == 1.0 and nz.metrics["zero_frames"] == 0 and nz.flags == []
    # diversity: informational (score None) but records the grasp position
    dv = res["diversity"]
    assert dv.score is None and dv.metrics["n_grasps"] == 1 and len(dv.metrics["grasp_pos_m"][0]) == 3
    # tracking error: cross-correlation lag agrees with the injected 2-frame delay
    te = res["tracking_error"]
    assert abs(te.metrics["lag_xcorr_frames.action.arm"] - 2.0) < 0.5, te.metrics
    assert abs(te.metrics["lag_ms.action.arm"] - 200.0) < 50  # 2 frames at 10 fps
    assert (
        te.metrics["lag_corr.action.arm"] > 0.5
    )  # 1 mm noise on a slow sine keeps the speed correlation moderate
    assert 0.0 <= te.metrics["lag_err_share.action.arm"] <= 1.0
    # grasp profile
    gc = res["grasp_cycles"]
    assert len(gc.metrics["close_dur_s"]) == 1 and gc.metrics["close_dur_s"][0] >= 0
    assert "active_frac" in gc.metrics and 0 < gc.metrics["active_frac"] <= 1


def test_zero_frame_is_caught_and_flagged(synthetic_dataset, spec):
    spec.hard_critics = default_hard_critics()
    ds = open_dataset(synthetic_dataset)
    ep = ds.episode(1)
    st = ep.array("observation.state.arm")
    st[0] = 0.0  # a transport dropout: pose exactly (0, 0, 0, ...)
    ep.df["observation.state.arm"] = list(st.astype("float32"))
    nz = next(c for c in build_hard_critics(spec) if c.id == "normalization").safe_evaluate(ep)
    assert "ZERO_FRAMES" in nz.flags and nz.metrics["zero_frames"] == 1
    assert nz.metrics["zero_frame_index.observation.state.arm"] == [0]
    assert nz.score == 0.5


def test_idle_arm_drift_and_action_copy(synthetic_dataset, spec):
    """An arm marked inactive that still travels ~1 m per episode is drift; an action that
    equals the state is a readback."""
    from lerobot_critics.dataset.features import detect_features
    from lerobot_critics.spec.models import HardCriticConfig

    spec.hard_critics = [HardCriticConfig(id="normalization")]
    ds = open_dataset(synthetic_dataset)
    ep = ds.episode(0)
    rf = detect_features(ds, spec, ep)
    for p in rf.pairs:
        if p.kind == "cartesian":
            p.active = False  # the synthetic feature has no left/right name; mark it idle explicitly
    ep.cache["features"] = rf
    ep.df["action.arm"] = ep.df["observation.state.arm"]  # action is a plain readback
    nz = build_hard_critics(spec)[0].safe_evaluate(ep)
    assert nz.error is None, nz.error
    assert "IDLE_ARM_DRIFT" in nz.flags
    assert nz.metrics["idle_arm_path_m.observation.state.arm"] > 0.5
    assert nz.metrics["action_equals_state.action.arm"] is True


def test_tremor_detects_input_device_shake(synthetic_dataset, spec):
    from lerobot_critics.spec.models import HardCriticConfig

    spec.hard_critics = [HardCriticConfig(id="tremor")]
    ds = open_dataset(synthetic_dataset)
    ep = ds.episode(0)
    a = ep.array("action.arm")
    t = np.arange(len(a)) / ep.fps
    # 4 Hz is the highest tremor we can inject at 10 fps (Nyquist 5 Hz); lower the cutoff accordingly
    a[:, 0] += 0.01 * np.sin(2 * np.pi * 4.0 * t)
    ep.df["action.arm"] = list(a.astype("float32"))
    crit = build_hard_critics(spec)[0]
    crit.params.update({"hf_cutoff_hz": 3.0, "peak_band_hz": [3.5, 5.0]})
    r = crit.safe_evaluate(ep)
    assert r.error is None, r.error
    assert r.metrics["hf5_share_cmd"] > r.metrics["hf5_share_state"] * 2
    assert r.metrics["tremor_source"] == "input_device"
    assert "TREMOR" in r.flags


def test_run_writes_glossary_findings_and_columns(synthetic_dataset, spec, tmp_path):
    spec.hard_critics = default_hard_critics()
    out = tmp_path / "out"
    rep = run(
        synthetic_dataset, spec, RunOptions(out_dir=str(out), workers=1, run_soft=False, contact_sheets=False)
    )
    # every emitted metric is documented
    assert undocumented_metrics(present_metrics(rep.episodes)) == []
    assert rep.metric_docs and "tremor.hf5_share_cmd" in rep.metric_docs
    assert rep.metric_docs["tracking_error.lag_ms.action.arm"]["feature"] == "action.arm"
    # dataset-level summaries exist for the new critics
    assert "diversity" in rep.dataset_summaries and "normalization" in rep.dataset_summaries
    assert rep.dataset_summaries["normalization"]["stats_file_found"] is False
    # 4 identical trajectories -> the grasp positions coincide -> LOW_DIVERSITY at run level
    assert "LOW_DIVERSITY" in rep.dataset_flags
    assert "grasp_offset_from_median_cm" in rep.episodes[0].hard[-1].metrics or any(
        "grasp_offset_from_median_cm" in h.metrics for e in rep.episodes for h in e.hard
    )
    # files
    md = (out / "report.md").read_text()
    assert "## Dataset-level findings" in md and "LOW_DIVERSITY" in md
    assert "## Metric glossary" in md and "`hf5_share_cmd`" in md and "lag_ms.<feature>" in md
    ai = (out / "report_ai.md").read_text()
    assert "### Dataset-level findings" in ai and "## Metric glossary" in ai
    cols = list(csv.DictReader((out / "episodes_columns.csv").open()))
    by = {c["column"]: c for c in cols}
    assert (
        by["tremor.hf5_share_cmd"]["unit"] == "fraction"
        and "5 Hz" in by["tremor.hf5_share_cmd"]["description"]
    )
    assert by["tracking_error.lag_ms.action.arm"]["description"].endswith("Feature: action.arm.")
    assert by["hard.tremor"]["critic"] == "tremor"
    header = next(csv.reader((out / "episodes.csv").open()))
    assert set(header) == set(by)  # one description row per CSV column
    js = json.loads((out / "report.json").read_text())
    assert js["dataset_flags"]["LOW_DIVERSITY"].startswith("3 grasps")  # episode 3 never grasps
    assert "metric_docs" in js and js["metric_docs"]["tremor.hf5_share_cmd"]["better"] == "lower"


def test_metric_doc_lookup():
    d = describe_metric("tracking_error", "pos_err_mean_mm.action.humanoid_v1.left_wrist")
    assert d is not None and d.unit == "mm" and d.per_feature
    assert describe_metric("tracking_error", "pos_err_mean_mm").per_feature is False
    z = describe_metric("smoothness", "z.hf_ratio")
    assert z is not None and z.label.startswith("z-score of")
    assert describe_metric("normalization", "_range.x") is None
    assert describe_metric("nope", "nothing") is None
    docs = all_metric_docs("tremor")
    assert docs and all(d["critic"] == "tremor" for d in docs) and all(d["what"] and d["how"] for d in docs)
    assert all(d["what"] and d["how"] for d in all_metric_docs())


def test_session_profile_and_visual_report(synthetic_dataset, spec, tmp_path):
    from lerobot_critics.session_profile import build_session_profile, indicators_by_group
    from lerobot_critics.visual_report import render_html_report

    spec.hard_critics = default_hard_critics()
    out = tmp_path / "out"
    rep = run(
        synthetic_dataset, spec, RunOptions(out_dir=str(out), workers=1, run_soft=False, contact_sheets=False)
    )
    prof = rep.session_profile
    assert prof and prof["indicators"], prof
    by = {i["id"]: i for i in prof["indicators"]}
    # the latency is a first-class indicator with a per-episode series, thresholds and text
    lag = by["latency_ms"]
    assert abs(lag["value"] - 200.0) < 60 and lag["n"] == 4 and len(lag["series"]) == 4  # 2 frames @ 10 fps
    assert lag["status"] in ("good", "warn", "bad") and lag["what"] and lag["so_what"] and lag["action"]
    assert "frames at 10 fps" in lag["display_extra"]
    assert by["latency_share"]["n"] == 4
    assert by["tremor_cmd"]["state_series"] and by["tremor_cmd"]["source"] in (
        "none",
        "input_device",
        "robot",
        "mixed",
    )
    assert by["grasp_spread_cm"]["status"] == "bad"  # identical trajectories -> no spread
    assert by["zero_frames"]["value"] == 0 and by["zero_frames"]["status"] == "good"
    assert prof["cameras"] and {c["short"] for c in prof["cameras"]} == {"front", "wrist"}
    assert len(prof["grasp_points"]) == 3 and prof["headline"]
    groups = indicators_by_group(prof)
    assert [g["id"] for g, _ in groups] == ["teleop", "grasp", "diversity", "hygiene"]
    assert build_session_profile(rep)["indicators"][0]["id"] == "latency_ms"  # recomputable from the report
    # rendered everywhere
    md = (out / "report.md").read_text()
    assert "## Recording session profile" in md and "Teleop latency: command → robot" in md
    ai = (out / "report_ai.md").read_text()
    assert "### Recording session profile" in ai and "| Teleop latency: command → robot |" in ai
    html = (out / "report.html").read_text()
    assert "Recording session profile" in html and "Teleop latency per episode" in html
    assert "Where the object was grasped" in html and "Tremor: command vs. robot state" in html
    assert render_html_report(rep, top_n=2).count("Teleop latency") >= 2
    js = json.loads((out / "report.json").read_text())
    assert js["session_profile"]["indicators"][0]["id"] == "latency_ms"
