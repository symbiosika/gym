"""The Gemini client asks for the API version agentic video needs, whatever the SDK's default."""

from lerobot_critics.critics.soft import providers


def test_the_gemini_client_pins_v1beta(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    prov = providers.GeminiProvider(model="gemini-3.7-flash", timeout_s=12)
    opts = prov.client._api_client._http_options
    assert opts.api_version == "v1beta"
    assert opts.timeout == 12_000
