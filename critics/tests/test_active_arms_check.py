from lerobot_critics.dataset.features import arm_motion, resolve_active_arms
from lerobot_critics.dataset.loader import LeRobotDataset


def test_motion_is_per_arm(two_arm_dataset, two_arm_spec):
    m = arm_motion(LeRobotDataset(two_arm_dataset), two_arm_spec([]))
    assert m["right"] > 5 * m["left"]


def test_unset_arms_default_to_the_moving_arm(two_arm_dataset, two_arm_spec):
    arms, flags = resolve_active_arms(LeRobotDataset(two_arm_dataset), two_arm_spec([]))
    assert arms == ["right"] and "ACTIVE_ARMS_UNSET" in flags


def test_wrong_arm_is_suspect(two_arm_dataset, two_arm_spec):
    arms, flags = resolve_active_arms(LeRobotDataset(two_arm_dataset), two_arm_spec(["left"]))
    assert arms == ["left"] and "ACTIVE_ARMS_SUSPECT" in flags


def test_unknown_arm_falls_back_to_all(two_arm_dataset, two_arm_spec):
    arms, flags = resolve_active_arms(LeRobotDataset(two_arm_dataset), two_arm_spec(["torso"]))
    assert arms == [] and "ACTIVE_ARMS_UNKNOWN" in flags


def test_single_arm_dataset_is_left_alone(synthetic_dataset, spec):
    arms, flags = resolve_active_arms(LeRobotDataset(synthetic_dataset), spec)
    assert arms == [] and flags == {}


def test_run_reports_and_scores_the_moving_arm(two_arm_dataset, tmp_path, two_arm_spec):
    from lerobot_critics.runner import RunOptions, run

    rep = run(
        two_arm_dataset,
        two_arm_spec([]),
        RunOptions(out_dir=str(tmp_path), run_soft=False, contact_sheets=False),
    )
    assert rep.active_arms == ["right"]
    assert "ACTIVE_ARMS_UNSET" in rep.dataset_flags
    assert rep.flag_counts.get("TRACKERR", 0) == 0
    assert rep.spec["robot"]["active_arms"] == ["right"]


def test_auto_spec_leaves_the_arms_to_the_runner(two_arm_dataset, tmp_path):
    from lerobot_critics.runner import RunOptions, run
    from lerobot_critics.spec.autospec import auto_spec

    spec = auto_spec(two_arm_dataset)
    assert spec.robot.active_arms == []
    spec.soft_critics.enabled = False
    rep = run(two_arm_dataset, spec, RunOptions(out_dir=str(tmp_path), run_soft=False, contact_sheets=False))
    assert rep.active_arms == ["right"] and "ACTIVE_ARMS_UNSET" in rep.dataset_flags


def test_auto_spec_keeps_the_arms_it_is_given(two_arm_dataset):
    from lerobot_critics.spec.autospec import auto_spec

    assert auto_spec(two_arm_dataset, active_arms=["left"]).robot.active_arms == ["left"]
