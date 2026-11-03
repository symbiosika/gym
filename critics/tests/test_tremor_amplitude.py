import numpy as np

from lerobot_critics.critics.hard._util import highpass_rms


def test_highpass_rms_isolates_the_tremor():
    t = np.arange(300) / 30.0
    x = np.stack([0.3 * np.sin(2 * np.pi * 0.2 * t) + 0.005 * np.sin(2 * np.pi * 10 * t), 0 * t, 0 * t], 1)
    assert abs(highpass_rms(x, 30.0, 5.0) - 0.005 / np.sqrt(2)) < 0.0005


def test_too_short_is_none():
    assert highpass_rms(np.zeros((8, 3)), 30.0, 5.0) is None


def _tremor_result(two_arm_dataset, two_arm_spec, ep_index):
    from lerobot_critics.critics.hard.tremor import TremorCritic
    from lerobot_critics.dataset.loader import LeRobotDataset

    ds = LeRobotDataset(two_arm_dataset)
    spec = two_arm_spec(["right"])
    return TremorCritic(spec.hard("tremor"), spec).evaluate(ds.episode(ep_index))


def test_one_millimetre_is_not_tremor(two_arm_dataset, two_arm_spec):
    r = _tremor_result(two_arm_dataset, two_arm_spec, 4)
    assert r.metrics["hf5_share_cmd"] > 0.2 and r.metrics["hf_pos_rms_cmd_mm"] < 1.5
    assert "TREMOR" not in r.flags


def test_five_millimetres_is_tremor(two_arm_dataset, two_arm_spec):
    r = _tremor_result(two_arm_dataset, two_arm_spec, 5)
    assert r.metrics["hf_pos_rms_cmd_mm"] > 3.0 and "TREMOR" in r.flags
    assert r.metrics["tremor_source"] == "input_device"


def _one_way_move(n=300, fs=30.0, dist=0.2):
    t = np.arange(n) / fs
    u = t / t[-1]
    smooth = dist * (10 * u**3 - 15 * u**4 + 6 * u**5)  # minimum-jerk, one way, no return
    return t, np.stack([smooth, 0.5 * smooth, 0 * t + 0.1], 1)


def test_a_smooth_one_way_move_is_not_tremor():
    _, x = _one_way_move()
    assert highpass_rms(x, 30.0, 5.0) < 0.0005


def test_a_one_way_move_keeps_the_tremor_rms():
    t, x = _one_way_move()
    x = x.copy()
    x[:, 1] += 0.004 * np.sin(2 * np.pi * 10 * t)
    rms = 0.004 / np.sqrt(2)
    assert abs(highpass_rms(x, 30.0, 5.0) - rms) < 0.1 * rms
