def test_two_arm_dataset_loads(two_arm_dataset):
    from lerobot_critics.dataset.loader import LeRobotDataset

    ds = LeRobotDataset(two_arm_dataset)
    assert len(ds.episode_indices()) == 6
    assert "action.bot.right_wrist" in ds.features and "observation.images.wrist_left" in ds.camera_keys
