"""Positions per arm in the diversity critic: on a robot whose arms take turns, the report
says for every episode which arm grasped and where each wrist started and ended, whatever
the spec names as the active arm. The figures the critic had before are not touched."""

import pytest

from lerobot_critics.runner import RunOptions, run


def _diversity(rep):
    out = {}
    for ep in rep.episodes:
        out[ep.episode] = next(c for c in ep.hard if c.id == "diversity").metrics
    return out


@pytest.fixture(scope="module")
def alternating_right_spec_run(alternating_arm_dataset, tmp_path_factory):
    """The arms take turns, but the spec names the right one only (as a skill's spec may)."""
    from lerobot_critics.spec.models import CriticSpec, RobotSpec, SoftCriticsConfig, TaskSpec, VLMConfig

    spec = CriticSpec(
        name="t",
        task=TaskSpec(instruction="pick"),
        robot=RobotSpec(active_arms=["right"]),
        soft_critics=SoftCriticsConfig(enabled=False, vlm=VLMConfig(provider="none")),
    )
    out = tmp_path_factory.mktemp("alternating_run")
    return run(
        alternating_arm_dataset, spec, RunOptions(out_dir=str(out), run_soft=False, contact_sheets=False)
    )


def test_every_episode_names_the_arm_that_grasped(alternating_right_spec_run):
    m = _diversity(alternating_right_spec_run)
    assert [m[e]["grasp_arm"] for e in sorted(m)] == ["right", "left", "right", "left", "right", "left"]


def test_grasp_positions_are_kept_per_arm_whatever_the_spec_names(alternating_right_spec_run):
    m = _diversity(alternating_right_spec_run)
    left_episode = m[1]
    assert len(left_episode["grasps_by_arm"]["left"]["grasp_pos_m"]) == 1
    assert len(left_episode["grasps_by_arm"]["left"]["grasp_pos_m"][0]) == 3
    # the arm that rested in this episode has no grasp of its own
    assert left_episode["grasps_by_arm"]["right"]["grasp_pos_m"] == []
    assert "release_pos_m" in left_episode["grasps_by_arm"]["left"]


def test_both_wrists_have_a_start_and_an_end_in_every_episode(alternating_right_spec_run):
    m = _diversity(alternating_right_spec_run)
    for e in m:
        assert set(m[e]["wrists"]) == {"left", "right"}
        for arm in ("left", "right"):
            assert len(m[e]["wrists"][arm]["start_pos_m"]) == 3
            assert len(m[e]["wrists"][arm]["end_pos_m"]) == 3
    # the parked arm of an episode stays where it is, the working one travels
    parked, working = m[0]["wrists"]["left"], m[0]["wrists"]["right"]
    assert max(abs(a - b) for a, b in zip(parked["start_pos_m"], parked["end_pos_m"], strict=True)) < 0.01
    assert max(abs(a - b) for a, b in zip(working["start_pos_m"], working["end_pos_m"], strict=True)) > 0.01


def test_what_the_critic_reported_before_is_unchanged(two_arm_dataset, tmp_path, two_arm_spec):
    """The existing keys follow the spec's arm as they did: values pinned from the code before
    the per-arm keys were added."""
    rep = run(
        two_arm_dataset,
        two_arm_spec([]),
        RunOptions(out_dir=str(tmp_path), run_soft=False, contact_sheets=False),
    )
    m = _diversity(rep)
    assert {e: (m[e]["wrist_feature"], m[e]["n_grasps"]) for e in m} == PINNED_FEATURE_AND_GRASPS
    assert {e: m[e]["grasp_pos_m"] for e in m} == PINNED_GRASP_POS
    assert {e: m[e]["start_pos_m"] for e in m} == PINNED_START_POS
    assert rep.dataset_summaries["diversity"]["grasp_positions"] == PINNED_SUMMARY
    # and the new keys agree with them where there is one working arm
    for e in m:
        assert m[e]["grasp_arm"] == "right"
        assert m[e]["grasps_by_arm"]["right"]["grasp_pos_m"] == m[e]["grasp_pos_m"]
        assert m[e]["wrists"]["right"]["start_pos_m"] == m[e]["start_pos_m"]


def test_a_single_arm_without_a_side_in_its_name_reports_no_arms(synthetic_dataset, tmp_path, spec):
    spec.soft_critics.enabled = False
    rep = run(
        synthetic_dataset, spec, RunOptions(out_dir=str(tmp_path), run_soft=False, contact_sheets=False)
    )
    for metrics in _diversity(rep).values():
        if "wrists" in metrics:  # absent when the critic had no cartesian state at all
            assert metrics["wrists"] == {} and metrics["grasps_by_arm"] == {} and metrics["grasp_arm"] is None


PINNED_FEATURE_AND_GRASPS: dict = {
    0: ("observation.state.bot.right_wrist", 1),
    1: ("observation.state.bot.right_wrist", 1),
    2: ("observation.state.bot.right_wrist", 1),
    3: ("observation.state.bot.right_wrist", 1),
    4: ("observation.state.bot.right_wrist", 1),
    5: ("observation.state.bot.right_wrist", 1),
}
PINNED_GRASP_POS: dict = {
    0: [[0.412, 0.0034, 0.8716]],
    1: [[0.4521, -0.0573, 0.8727]],
    2: [[0.4922, 0.0017, 0.8739]],
    3: [[0.5334, -0.0573, 0.8756]],
    4: [[0.5726, 0.0037, 0.8723]],
    5: [[0.612, -0.0578, 0.8746]],
}
PINNED_START_POS: dict = {
    0: [0.2203, 0.1308, 0.9003],
    1: [0.2601, 0.07, 0.9014],
    2: [0.2993, 0.1301, 0.9011],
    3: [0.3391, 0.0693, 0.9],
    4: [0.3784, 0.1298, 0.9034],
    5: [0.4194, 0.07, 0.9011],
}
PINNED_SUMMARY: dict = {
    "n": 6,
    "std_cm": [6.84, 3.02, 0.14],
    "robust_std_cm": [8.93, 4.41, 0.17],
    "range_cm": [20.0, 6.15, 0.4],
    "median_m": [0.5128, -0.0278, 0.8733],
}
