from lerobot_critics.critics.soft import vlm
from lerobot_critics.critics.soft.providers import VLMUnavailable
from lerobot_critics.runner import RunOptions, run


def test_a_billing_error_ends_the_soft_stage(two_arm_dataset, tmp_path, monkeypatch, two_arm_spec):
    calls = []

    def boom(self, ep, hard=None):
        calls.append(ep.index)
        raise VLMUnavailable("402 prepayment credits are depleted")

    monkeypatch.setattr(vlm.VLMJudge, "judge", boom)
    spec = two_arm_spec(["right"])
    spec.soft_critics.enabled = True
    spec.soft_critics.vlm.provider = "gemini"
    spec.soft_critics.vlm.mode = "frames"
    spec.soft_critics.vlm.max_concurrency = 1
    rep = run(two_arm_dataset, spec, RunOptions(out_dir=str(tmp_path), contact_sheets=False))
    assert len(calls) <= 2
    assert rep.dataset_flags["VLM_INCOMPLETE"].startswith("6 of 6 episodes have no soft verdict")
    assert rep.dataset_stats["vlm_incomplete_episodes"] == 6
    assert all(any(s.id == "vlm.summary" and s.error for s in e.soft) for e in rep.episodes)


def test_other_errors_do_not_end_the_stage(two_arm_dataset, tmp_path, monkeypatch, two_arm_spec):
    calls = []

    def flaky(self, ep, hard=None):
        calls.append(ep.index)
        raise ValueError("bad json")

    monkeypatch.setattr(vlm.VLMJudge, "judge", flaky)
    spec = two_arm_spec(["right"])
    spec.soft_critics.enabled = True
    spec.soft_critics.vlm.provider = "gemini"
    spec.soft_critics.vlm.mode = "frames"
    rep = run(two_arm_dataset, spec, RunOptions(out_dir=str(tmp_path), contact_sheets=False))
    assert len(calls) == 6
    assert rep.dataset_flags["VLM_INCOMPLETE"].startswith("6 of 6 episodes have no soft verdict")


def test_gemini_billing_errors_are_unavailable_and_transient_ones_retry(monkeypatch):
    from lerobot_critics.critics.soft import providers

    class Err(Exception):
        def __init__(self, code, msg):
            super().__init__(msg)
            self.code = code

    prov = providers.GeminiProvider.__new__(providers.GeminiProvider)
    monkeypatch.setattr(providers.time, "sleep", lambda s: None)
    n = {"c": 0}

    def billing():
        n["c"] += 1
        raise Err(402, "payment required")

    try:
        prov._generate(billing)
        raise AssertionError("no raise")
    except VLMUnavailable:
        pass
    assert n["c"] == 1

    seq = iter([Err(503, "overloaded"), Err(429, "slow"), "ok"])

    def flaky():
        v = next(seq)
        if isinstance(v, Exception):
            raise v
        return v

    assert prov._generate(flaky) == "ok"

    def exhausted():
        raise Err(400, "RESOURCE_EXHAUSTED: billing credit")

    try:
        prov._generate(exhausted)
        raise AssertionError("no raise")
    except VLMUnavailable:
        pass


class _ApiErr(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


_RATE_LIMIT_429 = (
    "429 RESOURCE_EXHAUSTED. {'error': {'code': 429, 'message': 'You exceeded your current quota, "
    "please check your plan and billing details. For more information on this error, head to: "
    "https://ai.google.dev/gemini-api/docs/rate-limits.', 'status': 'RESOURCE_EXHAUSTED'}}"
)
_CREDITS_429 = (
    "429 RESOURCE_EXHAUSTED. {'error': {'code': 429, 'message': 'Your prepayment credits are depleted. "
    "Please go to AI Studio to manage your project and billing.', 'status': 'RESOURCE_EXHAUSTED'}}"
)


def _gemini(monkeypatch):
    from lerobot_critics.critics.soft import providers

    waits = []
    monkeypatch.setattr(providers.time, "sleep", lambda s: waits.append(s))
    return providers.GeminiProvider.__new__(providers.GeminiProvider), waits


def test_a_rate_limit_429_that_mentions_billing_is_retried(monkeypatch):
    prov, waits = _gemini(monkeypatch)
    seq = iter([_ApiErr(429, _RATE_LIMIT_429), _ApiErr(429, _RATE_LIMIT_429), "ok"])

    def call():
        v = next(seq)
        if isinstance(v, Exception):
            raise v
        return v

    assert prov._generate(call) == "ok"
    assert waits == [2.0, 8.0]


def test_a_429_for_depleted_prepayment_credits_is_unavailable_at_once(monkeypatch):
    import pytest

    prov, waits = _gemini(monkeypatch)
    n = {"c": 0}

    def call():
        n["c"] += 1
        raise _ApiErr(429, _CREDITS_429)

    with pytest.raises(VLMUnavailable):
        prov._generate(call)
    assert n["c"] == 1 and waits == []


def test_a_429_that_outlasts_the_retries_is_unavailable(monkeypatch):
    import pytest

    prov, waits = _gemini(monkeypatch)
    n = {"c": 0}

    def call():
        n["c"] += 1
        raise _ApiErr(429, _RATE_LIMIT_429)

    with pytest.raises(VLMUnavailable):
        prov._generate(call)
    assert n["c"] == 4 and waits == [2.0, 8.0, 30.0]


def test_a_503_that_outlasts_the_retries_passes_through(monkeypatch):
    import pytest

    prov, waits = _gemini(monkeypatch)

    def call():
        raise _ApiErr(503, "overloaded")

    with pytest.raises(_ApiErr):
        prov._generate(call)
    assert waits == [2.0, 8.0, 30.0]
