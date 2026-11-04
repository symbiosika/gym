def test_pair_follows_the_hand_that_grasps(two_arm_dataset, two_arm_spec):
    from lerobot_critics.dataset.features import detect_features, gripper_arm_pair
    from lerobot_critics.dataset.loader import LeRobotDataset

    ds = LeRobotDataset(two_arm_dataset)
    ep = ds.episode(0)
    rf = detect_features(ds, two_arm_spec([]), ep)
    assert rf.gripper.feature == "observation.state.bot.right_hand"
    assert gripper_arm_pair(rf).state == "observation.state.bot.right_wrist"


def test_diversity_samples_the_grasping_wrist(two_arm_dataset, tmp_path, two_arm_spec):
    from lerobot_critics.runner import RunOptions, run

    rep = run(
        two_arm_dataset,
        two_arm_spec([]),
        RunOptions(out_dir=str(tmp_path), run_soft=False, contact_sheets=False),
    )
    g = rep.dataset_summaries["diversity"]["grasp_positions"]
    assert 0.85 < g["median_m"][2] < 1.0  # the right wrist's z, not the parked arm's 0.45
    assert "LOW_DIVERSITY" not in rep.dataset_flags
