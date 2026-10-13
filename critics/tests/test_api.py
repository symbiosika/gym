import json
import time
from pathlib import Path

import pytest

fastapi = pytest.importorskip("fastapi")


@pytest.fixture
def client(synthetic_dataset, tmp_path, monkeypatch):
    monkeypatch.setenv("CRITICS_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("CRITICS_SPECS_DIR", str(tmp_path / "specs"))
    monkeypatch.setenv("CRITICS_DATA_DIR", str(synthetic_dataset.parent))
    import importlib

    from lerobot_critics.api import app as app_module

    importlib.reload(app_module)
    from fastapi.testclient import TestClient

    return TestClient(app_module.app)


def test_health_and_critics(client):
    assert client.get("/health").json()["status"] == "ok"
    ids = {c["id"] for c in client.get("/critics").json()}
    assert "smoothness" in ids


def test_spec_crud(client):
    body = {"name": "t1", "task": {"instruction": "do it"}}
    assert client.post("/specs", json=body).status_code == 201
    assert any(s["name"] == "t1" for s in client.get("/specs").json())
    got = client.get("/specs/t1").json()
    assert got["task"]["instruction"] == "do it" and got["hard_critics"]
    assert client.delete("/specs/t1").status_code == 204
    assert client.get("/specs/t1").status_code == 404


def test_job_lifecycle(client, synthetic_dataset):
    spec = {
        "name": "j",
        "task": {"instruction": "put the red block in the box", "expected_cycles": 1},
        "robot": {"gripper": {"feature": "observation.state.gripper"}},
        "soft_critics": {"enabled": False},
    }
    r = client.post(
        "/jobs",
        json={
            "dataset": str(synthetic_dataset),
            "spec": spec,
            "options": {"workers": 1, "contact_sheets": False},
        },
    )
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    for _ in range(120):
        st = client.get(f"/jobs/{job_id}").json()
        if st["status"] in ("done", "failed"):
            break
        time.sleep(0.5)
    assert st["status"] == "done", st
    assert st["n_episodes"] == 4
    rep = client.get(f"/jobs/{job_id}/report").json()
    assert len(rep["episodes"]) == 4
    sel = client.get(f"/jobs/{job_id}/selection").json()
    assert 0 in sel["include"]
    assert client.get(f"/jobs/{job_id}/report.md").text.startswith("# Critic report")
    # the spec the job ran with is retrievable as YAML
    sp = client.get(f"/jobs/{job_id}/spec")
    assert sp.status_code == 200 and "put the red block in the box" in sp.text

    # downgrading findings replays the verdicts; the run itself is untouched
    before = rep["counts"]
    blocking = sorted({f for r in sel["reasons"].values() for f in r["blocking"]})
    assert blocking, "the synthetic dataset has filtered episodes"
    r = client.put(f"/jobs/{job_id}/overrides", json={"ignore_flags": blocking, "review_flags": []})
    assert r.status_code == 200, r.text
    assert r.json()["overrides"] == {"ignore_flags": blocking, "review_flags": [], "disabled_critics": []}
    after = client.get(f"/jobs/{job_id}/report").json()
    assert after["overrides"]["ignore_flags"] == blocking
    assert after["counts"]["reject"] <= before["reject"]
    assert len(after["include"]) + len(after["review"]) + len(after["exclude"]) == 4
    assert client.get(f"/jobs/{job_id}").json()["counts"] == after["counts"]
    sel2 = client.get(f"/jobs/{job_id}/selection").json()
    assert sel2["include"] == after["include"] and sel2["exclude"] == after["exclude"]
    for f in blocking:
        assert f not in after["flag_counts"]
    # a critic switched off for this dataset: no weight, no gate
    critics_ = sorted({c["id"] for e in rep["episodes"] for c in e["hard"] if c["gate_failed"]})
    r = client.put(f"/jobs/{job_id}/overrides", json={"disabled_critics": critics_})
    assert r.status_code == 200, r.text
    assert r.json()["overrides"]["disabled_critics"] == critics_
    off = client.get(f"/jobs/{job_id}/report").json()
    assert off["counts"]["reject"] <= before["reject"]
    assert all(
        not any(c["id"] in critics_ and f in e["score"]["flags"] for c in e["hard"] for f in c["flags"])
        for e in off["episodes"]
    )
    # taking them back restores the original verdicts
    r = client.put(f"/jobs/{job_id}/overrides", json={})
    assert r.status_code == 200
    restored = client.get(f"/jobs/{job_id}/report").json()
    assert restored["counts"] == before
    assert restored["overrides"] == {"ignore_flags": [], "review_flags": [], "disabled_critics": []}
    assert client.put("/jobs/nope/overrides", json={}).status_code == 404
    # visual report: rendered on request (?top=N) and written to the run directory
    html = client.get(f"/jobs/{job_id}/report.html", params={"top": 2})
    assert html.status_code == 200 and html.headers["content-type"].startswith("text/html")
    assert html.text.startswith("<!doctype html>") and html.text.count('class="ep"') == 2
    assert f"/jobs/{job_id}/files/report.md" in html.text  # artifact links point at this job
    assert client.get(f"/jobs/{job_id}/files/report.html").status_code == 200
    assert client.get(f"/jobs/{job_id}/episodes/2").json()["episode"] == 2
    assert client.get(f"/jobs/{job_id}/files/episodes.csv").status_code == 200
    assert client.get(f"/jobs/{job_id}/files/../status.json").status_code == 404
    assert any(j["job_id"] == job_id for j in client.get("/jobs").json())
    # AI-readable markdown ("copy as markdown")
    assert client.get(f"/jobs/{job_id}/files/report_ai.md").status_code == 200
    md = client.get(f"/jobs/{job_id}/markdown")
    assert md.status_code == 200 and md.headers["content-type"].startswith("text/markdown")
    assert md.text.startswith("# lerobot-critics report") and "### Episode 2" in md.text
    assert "put the red block in the box" in md.text and "### Scoring rules" in md.text
    r = client.get(f"/jobs/{job_id}/markdown", params={"detail": "summary", "episodes": "0,2-3"})
    assert r.status_code == 200 and "## Episode details" not in r.text
    assert "| 1 | accept |" not in r.text and "| 0 | accept |" in r.text
    assert client.get(f"/jobs/{job_id}/markdown", params={"detail": "verbose"}).status_code == 422
    assert client.get(f"/jobs/{job_id}/markdown", params={"episodes": "x-y"}).status_code == 422
    ep = client.get(f"/jobs/{job_id}/episodes/2/markdown")
    assert ep.status_code == 200 and ep.headers["content-type"].startswith("text/markdown")
    assert (
        ep.text.startswith("# lerobot-critics · ") and "episode 2" in ep.text and "Episode 3" not in ep.text
    )
    assert client.get(f"/jobs/{job_id}/episodes/99/markdown").status_code == 404
    # synchronous evaluate can answer in markdown too
    r = client.post(
        "/evaluate",
        params={"format": "markdown"},
        json={"dataset": str(synthetic_dataset), "spec": spec, "options": {"episodes": [0], "workers": 1}},
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/markdown") and "### Episode 0" in r.text


def test_api_key_required(synthetic_dataset, tmp_path, monkeypatch):
    monkeypatch.setenv("CRITICS_JOBS_DIR", str(tmp_path / "jobs"))
    monkeypatch.setenv("CRITICS_SPECS_DIR", str(tmp_path / "specs"))
    monkeypatch.setenv("CRITICS_API_KEY", "s3cret")
    import importlib

    from lerobot_critics.api import app as app_module

    importlib.reload(app_module)
    from fastapi.testclient import TestClient

    c = TestClient(app_module.app)
    assert c.get("/health").status_code == 200
    assert c.get("/critics").status_code == 401
    assert c.get("/critics", headers={"X-API-Key": "s3cret"}).status_code == 200
    assert c.get("/critics", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    monkeypatch.delenv("CRITICS_API_KEY")
    importlib.reload(app_module)


def test_ui_datasets_upload(client, synthetic_dataset, tmp_path):
    import io
    import zipfile

    assert client.get("/", follow_redirects=False).status_code in (302, 307)
    html = client.get("/ui").text
    assert "<title>lerobot-critics</title>" in html and "/upload" in html
    assert "Copy as Markdown" in html and "/markdown" in html
    assert "Check dataset" in html and "Recording session profile" in html
    ds = client.get("/datasets").json()
    assert any(d["name"] == synthetic_dataset.name for d in ds)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for p in synthetic_dataset.rglob("*"):
            if p.is_file():
                z.write(p, f"nested/{p.relative_to(synthetic_dataset)}")
    r = client.post("/upload", files={"file": ("uploaded_ds.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "uploaded_ds" and r.json()["episodes"] == 4
    assert any(d["name"] == "uploaded_ds" for d in client.get("/datasets").json())
    r = client.post("/upload", files={"file": ("uploaded_ds.zip", buf.getvalue(), "application/zip")})
    assert r.status_code == 409
    r = client.post(
        "/upload", files={"file": ("junk.zip", zipfile_bytes_without_dataset(), "application/zip")}
    )
    assert r.status_code == 400


def zipfile_bytes_without_dataset() -> bytes:
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("readme.txt", "nothing here")
    return buf.getvalue()


def test_job_store_status_is_atomic(tmp_path):
    """Readers polling status.json must never observe a partially written file."""
    import threading

    from lerobot_critics.api.jobs import JobStore

    store = JobStore(tmp_path / "jobs", tmp_path / "data")
    job_id = "j1"
    (store.root / job_id).mkdir()
    store._write(job_id, status="queued", payload="x" * 20000)
    stop = threading.Event()

    def writer():
        i = 0
        while not stop.is_set():
            store._write(job_id, status="running", counter=i, payload="y" * 20000)
            i += 1

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    try:
        for _ in range(300):
            st = store.read(job_id)
            assert st is not None and st["status"] in ("queued", "running")
    finally:
        stop.set()
        t.join(timeout=5)
    assert not list((store.root / job_id).glob("*.tmp"))


def test_auto_spec_is_saved_in_the_store(client, synthetic_dataset):
    """
    spec=null generates a spec from the dataset AND keeps it as '<dataset>-auto'
    for later runs.

    Generating it needs the data, so it happens in the job and not in the
    request: the name is known at once, the spec itself once the job has the
    dataset in front of it.
    """
    r = client.post(
        "/jobs",
        json={
            "dataset": str(synthetic_dataset),
            "spec": None,
            "options": {"workers": 1, "contact_sheets": False, "run_soft": False, "episodes": [0]},
        },
    )
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    name = f"{synthetic_dataset.name}-auto"
    # the name is known before the data is: the job answers with it right away
    assert client.get(f"/jobs/{job_id}").json()["spec_name"] == name

    for _ in range(120):
        st = client.get(f"/jobs/{job_id}").json()
        if st["status"] in ("done", "failed"):
            break
        time.sleep(0.5)
    assert st["status"] == "done", st

    assert any(s["name"] == name for s in client.get("/specs").json())
    stored = client.get(f"/specs/{name}").json()
    assert stored["task"]["instruction"] == "put the red block in the box"
    assert stored["task"]["expected_cycles"] == 1  # guessed from the grasp cycles of the first episodes
    assert client.get(f"/jobs/{job_id}").json()["spec_name"] == name
    assert f"name: {name}" in client.get(f"/jobs/{job_id}/spec").text


def test_merge_endpoint_returns_one_trainable_dataset(client, synthetic_dataset):
    import io
    import json
    import zipfile

    r = client.post(
        "/merge",
        json={
            "name": "session export",
            "sources": [{"dataset": synthetic_dataset.name, "episodes": [0, 2]}],
        },
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["x-merged-episodes"] == "2"
    assert "session_export.zip" in r.headers["content-disposition"]

    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        names = z.namelist()
        assert "session_export/meta/info.json" in names
        assert "session_export/manifest.json" in names
        assert "session_export/data/chunk-000/episode_000000.parquet" in names
        assert "session_export/data/chunk-000/episode_000001.parquet" in names
        assert any(n.endswith("episode_000001.mp4") for n in names)
        info = json.loads(z.read("session_export/meta/info.json"))
        assert info["total_episodes"] == 2
        assert info["codebase_version"] == "v2.1"
        manifest = json.loads(z.read("session_export/manifest.json"))
        assert manifest["sources"][0]["episodes"] == [
            {"episode": 0, "sourceEpisode": 0},
            {"episode": 1, "sourceEpisode": 2},
        ]


def test_merge_endpoint_rejects_bad_input(client, synthetic_dataset):
    assert client.post("/merge", json={"sources": []}).status_code == 400
    assert client.post("/merge", json={"sources": [{"dataset": "nope", "episodes": [0]}]}).status_code == 404
    r = client.post("/merge", json={"sources": [{"dataset": synthetic_dataset.name, "episodes": [99]}]})
    assert r.status_code == 400 and "no episode 99" in r.text


# ----------------------------------------------------------------- temporary URLs
#
# The service does not own the datasets it analyses: the app that owns them
# hands over a temporary URL instead of the bytes. These tests serve the zip
# from a real HTTP server on localhost, so the whole path is walked: fetch,
# unpack, use, and leave nothing behind.


@pytest.fixture
def dataset_url(synthetic_dataset):
    """The synthetic dataset, zipped and served over HTTP for the length of a test."""
    import http.server
    import io
    import threading
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for f in sorted(synthetic_dataset.rglob("*")):
            if f.is_file():
                z.write(f, f"{synthetic_dataset.name}/{f.relative_to(synthetic_dataset)}")
    body = buf.getvalue()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # keep the test output quiet
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # the token stands in for the signature of a presigned link: it is part of
    # the URL and must never end up in a status file
    yield f"http://127.0.0.1:{server.server_port}/scene.zip?token=secret-signature"
    server.shutdown()


@pytest.fixture
def dataset_part_urls(synthetic_dataset):
    """
    The synthetic dataset, zipped, cut into three parts and served over HTTP:
    how the app hands over an archive it keeps in the chunks it was uploaded in.
    """
    import http.server
    import io
    import threading
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for f in sorted(synthetic_dataset.rglob("*")):
            if f.is_file():
                z.write(f, f"{synthetic_dataset.name}/{f.relative_to(synthetic_dataset)}")
    body = buf.getvalue()
    size = len(body) // 3 + 1
    parts = [body[i : i + size] for i in range(0, len(body), size)]
    assert len(parts) == 3

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            index = int(self.path.split("?")[0].rsplit("/", 1)[-1].removesuffix(".bin"))
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(parts[index])))
            self.end_headers()
            self.wfile.write(parts[index])

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield [
        f"http://127.0.0.1:{server.server_port}/part/{i}.bin?token=secret-signature"
        for i in range(len(parts))
    ]
    server.shutdown()


def _wait(client, job_id, seconds=120):
    for _ in range(seconds * 10):
        st = client.get(f"/jobs/{job_id}").json()
        if st["status"] in ("done", "failed"):
            return st
        time.sleep(0.1)
    raise AssertionError("job did not finish")


def test_job_from_a_temporary_url_keeps_nothing_outside_its_own_directory(client, dataset_url, tmp_path):
    spec = {
        "name": "url-job",
        "task": {"instruction": "put the red block in the box", "expected_cycles": 1},
        "robot": {"gripper": {"feature": "observation.state.gripper"}},
        "soft_critics": {"enabled": False},
    }
    r = client.post("/jobs", json={"dataset": dataset_url, "spec": spec, "options": {"episodes": [0]}})
    assert r.status_code == 202, r.text
    st = _wait(client, r.json()["job_id"])
    assert st["status"] == "done", st.get("error")

    jobs_dir = tmp_path / "jobs"
    job_dir = jobs_dir / r.json()["job_id"]
    # the working copy belongs to the job
    assert Path(st["dataset_path"]).is_relative_to(job_dir)
    # the archive is gone as soon as it is unpacked: a dataset is large enough
    # that keeping both would double what the service needs
    assert not (job_dir / "download.zip").exists()
    # and nothing was written into the data directory on the app's behalf
    assert not any(p.name == "download.zip" for p in tmp_path.rglob("*"))

    # deleting the job takes the data with it
    assert client.delete(f"/jobs/{r.json()['job_id']}").status_code == 204
    assert not job_dir.exists()


def test_a_job_starts_at_once_even_when_the_spec_has_to_be_generated(client, dataset_url):
    """
    `spec: null` means "generate one from the dataset". That needs the data, so
    it must happen in the job and not in the request: a request that fetches
    gigabytes before it answers is exactly what every proxy on the way kills.
    """
    t0 = time.time()
    r = client.post("/jobs", json={"dataset": dataset_url, "spec": None, "options": {"episodes": [0]}})
    assert r.status_code == 202, r.text
    assert time.time() - t0 < 5

    st = _wait(client, r.json()["job_id"])
    assert st["status"] == "done", st.get("error")
    # the generated spec is kept, so the run can be reproduced and refined
    assert st["spec_name"] == "scene.zip-auto"
    assert client.get(f"/specs/{st['spec_name']}").status_code == 200
    assert "name: scene.zip-auto" in client.get(f"/jobs/{r.json()['job_id']}/spec").text


def test_merge_takes_temporary_urls_and_the_name_they_carry(client, dataset_url):
    import io
    import json
    import zipfile

    r = client.post(
        "/merge",
        json={
            "name": "session export",
            "sources": [{"dataset": dataset_url, "episodes": [0, 2], "name": "block_box_a"}],
        },
    )
    assert r.status_code == 200, r.text
    assert r.headers["x-merged-episodes"] == "2"
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        manifest = json.loads(z.read("session_export/manifest.json"))
        # the given name is what the manifest carries, never the link
        assert manifest["sources"][0]["dataset"] == "block_box_a"
        assert "token" not in json.dumps(manifest)


def test_merge_says_which_source_it_could_not_fetch(client):
    # a link that has expired, or a host that is not there: the answer names the
    # source by its name and not by its URL, which carries a token
    r = client.post(
        "/merge",
        json={
            "sources": [
                {
                    "dataset": "http://127.0.0.1:9/gone.zip?token=secret-signature",
                    "episodes": [0],
                    "name": "block_box_a",
                }
            ]
        },
    )
    assert r.status_code == 502
    assert "block_box_a" in r.text
    assert "secret-signature" not in r.text


def test_a_job_joins_a_dataset_that_comes_in_parts(client, dataset_part_urls, tmp_path):
    """
    A dataset of several gigabytes is kept by the app in the chunks it was
    uploaded in. The parts are fetched in order and joined into the zip here,
    and no link, which carries a token, ends up in the status of the job.
    """
    spec = {
        "name": "parts-job",
        "task": {"instruction": "put the red block in the box", "expected_cycles": 1},
        "robot": {"gripper": {"feature": "observation.state.gripper"}},
        "soft_critics": {"enabled": False},
    }
    r = client.post(
        "/jobs", json={"dataset_parts": dataset_part_urls, "spec": spec, "options": {"episodes": [0]}}
    )
    assert r.status_code == 202, r.text
    assert "secret-signature" not in r.text
    st = _wait(client, r.json()["job_id"])
    assert st["status"] == "done", st.get("error")
    assert st["dataset"] == "0.bin (3 parts)"
    assert "secret-signature" not in json.dumps(st)
    assert not (tmp_path / "jobs" / r.json()["job_id"] / "download.zip").exists()


def test_merge_takes_a_dataset_in_parts(client, dataset_part_urls):
    import io
    import zipfile

    r = client.post(
        "/merge",
        json={
            "name": "parts",
            "sources": [{"dataset_parts": dataset_part_urls, "episodes": [0, 1], "name": "big_one"}],
        },
    )
    assert r.status_code == 200, r.text
    assert r.headers["x-merged-episodes"] == "2"
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        assert json.loads(z.read("parts/manifest.json"))["sources"][0]["dataset"] == "big_one"

    assert client.post("/merge", json={"sources": [{"episodes": [0]}]}).status_code == 422


def test_a_sample_with_a_generated_spec_that_is_not_stored(client, synthetic_dataset):
    """
    What an app does to draft a spec: run the automatic spec over a sample of a
    dataset and keep the generated spec with the job only. The spec store stays
    as it was; the report says how many of the dataset's episodes it looked at.
    """
    before = {s["name"] for s in client.get("/specs").json()}
    r = client.post(
        "/jobs",
        json={
            "dataset": str(synthetic_dataset),
            "spec": None,
            "store_auto_spec": False,
            "options": {"workers": 1, "run_soft": False, "max_episodes": 2, "sheets_for_all": True},
        },
    )
    assert r.status_code == 202, r.text
    st = _wait(client, r.json()["job_id"])
    assert st["status"] == "done", st.get("error")
    assert {s["name"] for s in client.get("/specs").json()} == before
    report = client.get(f"/jobs/{r.json()['job_id']}/report").json()
    assert report["n_episodes"] == 2
    assert report["dataset_episodes"] > 2
    # spread over the dataset: the first and the last episode
    assert [e["episode"] for e in report["episodes"]] == [0, report["dataset_episodes"] - 1]
    assert report["spec"]["task"]["instruction"] == "put the red block in the box"
    # a contact sheet of every episode of the sample, accepted or not
    for e in report["episodes"]:
        sheet = client.get(f"/jobs/{r.json()['job_id']}/files/sheets/episode_{e['episode']:06d}.jpg")
        assert sheet.status_code == 200, e["score"]["verdict"]
