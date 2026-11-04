def test_no_unfinished_grasp_when_the_task_ends_in_hand(two_arm_dataset, tmp_path, two_arm_spec):
    from lerobot_critics.runner import RunOptions, run

    spec = two_arm_spec(["right"])
    spec.task.ends_in_hand = True
    rep = run(two_arm_dataset, spec, RunOptions(out_dir=str(tmp_path), run_soft=False, contact_sheets=False))
    assert rep.flag_counts.get("UNFINISHED_GRASP", 0) == 0


def test_unfinished_grasp_without_the_switch(two_arm_dataset, tmp_path, two_arm_spec):
    from lerobot_critics.runner import RunOptions, run

    rep = run(
        two_arm_dataset,
        two_arm_spec(["right"]),
        RunOptions(out_dir=str(tmp_path), run_soft=False, contact_sheets=False),
    )
    assert rep.flag_counts.get("UNFINISHED_GRASP", 0) == 6
