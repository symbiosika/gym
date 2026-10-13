"""REST API.

    lerobot-critics serve --port 8080
    docker run -p 8080:8080 -v /data:/data -e GEMINI_API_KEY=... lerobot-critics

Endpoints
---------
GET  /health
GET  /critics                      built-in hard critics + defaults
GET  /specs, POST /specs, GET/PUT/DELETE /specs/{name}
POST /specs/auto                   {"dataset": "..."} -> starter spec for a dataset
POST /jobs                         {"dataset": path|url|hf-id, "spec": name|object, "purpose": recording|evaluation, "options": {...}}
GET  /jobs, GET /jobs/{id}, DELETE /jobs/{id}
GET  /jobs/{id}/spec               the spec the job ran with (YAML); "auto" specs are also stored as <dataset>-auto
PUT  /jobs/{id}/overrides          downgrade findings (review / ignore), switch critics off, replay the verdicts
GET  /jobs/{id}/report             report.json
GET  /jobs/{id}/report.md          markdown (for people)
GET  /jobs/{id}/report.html        visual report with charts, printable to PDF (?top=5)
GET  /jobs/{id}/markdown           self-contained AI-readable markdown (?detail=summary|flagged|full&episodes=0,3-5)
GET  /jobs/{id}/selection          include/review/exclude lists + why each episode was filtered
GET  /jobs/{id}/episodes/{ep}      one episode's results
GET  /jobs/{id}/episodes/{ep}/markdown   one episode as AI-readable markdown
GET  /jobs/{id}/files/{path}       any artifact (csv, sheets, composites)
POST /evaluate                     synchronous run of a small episode subset (blocking; ?format=markdown)
GET  /datasets                     datasets found under CRITICS_DATA_DIR
POST /upload                       multipart zip of a LeRobot dataset -> stored under CRITICS_DATA_DIR
POST /merge                        {"name": ..., "sources": [{"dataset": url|path, "episodes": [...], "name": ...}]} ->
                                   the selected episodes of several datasets as one LeRobot v2.1 dataset (zip)
GET  /ui                           minimal web UI (upload, run, browse results)

Where the data comes from
-------------------------
The service does not own the datasets it analyses. The app that owns them keeps
them and hands over a **temporary URL** instead of the bytes: a presigned link
of an object store, or a signed link of the app itself. `/jobs` and `/merge`
take such a URL wherever they take a dataset, fetch what they need into the
working directory of that job or that request, and leave nothing behind when it
is deleted. A link carries a token, so it is never written to a status file and
never logged; that is what the `name` of a merge source is for.

`CRITICS_DATA_DIR` is the root a bare dataset name is resolved against, and what
`/upload`, `/datasets` and the web UI work with. It is there for the CLI, for
local work and for a dataset somebody put there by hand. Nothing the service
does on behalf of an app writes into it.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Literal

import yaml
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, RedirectResponse, Response
from pydantic import BaseModel, Field

from .. import __version__
from ..ai_report import render_ai_markdown, render_episode_markdown
from ..critics.registry import list_hard_critics
from ..runner import DatasetReport, RunOptions, parse_episodes
from ..spec.autospec import auto_spec
from ..spec.models import CriticSpec, Purpose, load_spec
from .jobs import JobStore
from .sources import DatasetSource, source_label
from .sources import resolve_dataset as resolve_source

JOBS_DIR = Path(os.environ.get("CRITICS_JOBS_DIR", "jobs"))
SPECS_DIR = Path(os.environ.get("CRITICS_SPECS_DIR", "specs_store"))
DATA_DIR = Path(os.environ.get("CRITICS_DATA_DIR", "data"))

API_KEY = os.environ.get("CRITICS_API_KEY")


async def require_api_key(
    request: Request, authorization: str | None = Header(None), x_api_key: str | None = Header(None)
) -> None:
    """Bearer / X-API-Key check, active only when CRITICS_API_KEY is set. /health stays open."""
    if not API_KEY or request.url.path in ("/health", "/", "/ui"):
        return
    token = x_api_key or (
        authorization[7:] if authorization and authorization.lower().startswith("bearer ") else None
    )
    if token != API_KEY:
        raise HTTPException(401, "invalid or missing API key")


app = FastAPI(
    title="lerobot-critics", version=__version__, description=__doc__, dependencies=[Depends(require_api_key)]
)
store = JobStore(JOBS_DIR, DATA_DIR, SPECS_DIR)
SPECS_DIR.mkdir(parents=True, exist_ok=True)


class JobRequest(BaseModel):
    dataset: str | None = Field(
        None, description="Local path (relative to CRITICS_DATA_DIR or absolute), zip URL, or HF repo id"
    )
    datasets: list[str] | None = Field(None, description="Several datasets -> one job per dataset, same spec")
    dataset_parts: list[str] | None = Field(
        None,
        description="One zipped dataset stored in parts: temporary http(s) URLs, fetched in order and "
        "joined into the zip. How an app hands over an archive of several gigabytes it never puts together.",
    )
    spec: str | dict[str, Any] | None = Field(
        None, description="Stored spec name, inline spec object, or null = auto"
    )
    purpose: Purpose | None = Field(
        None,
        description="What the episodes are: 'recording' (demonstrations judged as training data) or "
        "'evaluation' (rollouts of a policy judged on the outcome). Overrides the spec's own purpose "
        "for this run; null keeps it.",
    )
    options: RunOptions = Field(default_factory=RunOptions)
    store_auto_spec: bool = Field(
        True,
        description="With spec=null: keep the generated spec as '<dataset>-auto' in the spec store. "
        "False keeps it with the job only (GET /jobs/{id}/spec, the report), for an app that drafts "
        "a spec from a sample and stores the finished one itself.",
    )

    def all_datasets(self) -> list[DatasetSource]:
        out: list[DatasetSource] = list(self.datasets or [])
        if self.dataset_parts:
            out.insert(0, list(self.dataset_parts))
        if self.dataset:
            out.insert(0, self.dataset)
        if not out:
            raise HTTPException(422, "dataset or datasets required")
        return out


class AutoSpecRequest(BaseModel):
    dataset: str
    active_arms: list[str] | None = None


def _auto_spec_name(dataset: DatasetSource) -> str:
    import re

    stem = source_label(dataset)
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", stem).strip("._") + "-auto"


def _resolve_spec(
    spec: str | dict[str, Any] | None, dataset: DatasetSource, purpose: Purpose | None = None
) -> CriticSpec | None:
    """
    The spec of a run, or None for "generate one from the dataset".

    The automatic spec needs the data, and fetching the data is the job's work,
    not the request's: see JobStore.submit. Only a stored or an inline spec is
    resolved here, because both are on hand. ``purpose`` is the run's word on
    what the episodes are and overrides the spec's; the stored spec stays as it is.
    """
    if spec is None:
        return None
    if isinstance(spec, dict):
        return load_spec(spec, purpose)
    path = SPECS_DIR / f"{spec}.yaml"
    if not path.is_file():
        raise HTTPException(404, f"spec '{spec}' not found")
    return load_spec(path, purpose)


STATIC_DIR = Path(__file__).parent / "static"


@app.get("/", include_in_schema=False)
def root() -> RedirectResponse:
    return RedirectResponse("/ui")


@app.get("/ui", response_class=HTMLResponse, include_in_schema=False)
def ui() -> str:
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


def _dataset_summary(root: Path) -> dict[str, Any]:
    try:
        info = json.loads((root / "meta" / "info.json").read_text())
    except Exception:  # noqa: BLE001
        return {"name": root.name, "path": str(root), "error": "unreadable info.json"}
    task = None
    tp = root / "meta" / "tasks.jsonl"
    if tp.is_file():
        first = tp.read_text().splitlines()[:1]
        if first:
            task = json.loads(first[0]).get("task")
    return {
        "name": str(root.relative_to(DATA_DIR)) if root.is_relative_to(DATA_DIR) else str(root),
        "path": str(root),
        "robot_type": info.get("robot_type"),
        "episodes": info.get("total_episodes"),
        "fps": info.get("fps"),
        "cameras": [k for k, v in info.get("features", {}).items() if v.get("dtype") in ("video", "image")],
        "task": task,
        "version": info.get("codebase_version"),
    }


@app.get("/datasets")
def list_datasets() -> list[dict[str, Any]]:
    """LeRobot datasets under CRITICS_DATA_DIR (any depth <= 3)."""
    out = []
    if DATA_DIR.is_dir():
        for info in sorted(DATA_DIR.glob("*/meta/info.json")) + sorted(DATA_DIR.glob("*/*/meta/info.json")):
            out.append(_dataset_summary(info.parent.parent))
    return out


@app.post("/upload", status_code=201)
async def upload_dataset(file: UploadFile = File(...), name: str | None = None) -> dict[str, Any]:
    """Upload a zipped LeRobot dataset; it is extracted to CRITICS_DATA_DIR/<name>."""
    import shutil
    import zipfile

    stem = name or Path(file.filename or "dataset").stem
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", stem).strip("._") or "dataset"
    dest = DATA_DIR / stem
    if dest.exists():
        raise HTTPException(409, f"dataset '{stem}' already exists")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_zip = DATA_DIR / f".{stem}.upload.zip"
    with tmp_zip.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    try:
        tmp_dir = DATA_DIR / f".{stem}.extract"
        shutil.rmtree(tmp_dir, ignore_errors=True)
        with zipfile.ZipFile(tmp_zip) as z:
            z.extractall(tmp_dir)
        infos = list(tmp_dir.rglob("meta/info.json"))
        if not infos:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise HTTPException(400, "zip does not contain a LeRobot dataset (meta/info.json)")
        shutil.move(str(infos[0].parent.parent), str(dest))
        shutil.rmtree(tmp_dir, ignore_errors=True)
    finally:
        tmp_zip.unlink(missing_ok=True)
    return _dataset_summary(dest)


class MergeSourceRequest(BaseModel):
    dataset: str | None = Field(
        None,
        description=(
            "A temporary http(s) URL to the zipped dataset, a dataset name under "
            "CRITICS_DATA_DIR, or an absolute path"
        ),
    )
    dataset_parts: list[str] | None = Field(
        None, description="Instead of `dataset`: the zip in parts, temporary http(s) URLs joined in order"
    )
    episodes: list[int] = Field(..., description="The episode indexes of that dataset to take over")
    name: str | None = Field(
        None,
        description=(
            "The name of this source inside the merged dataset and its manifest. "
            "Give it when the source is a URL: a link carries a token, not a name."
        ),
    )

    def source(self) -> DatasetSource:
        if self.dataset_parts:
            return list(self.dataset_parts)
        if self.dataset:
            return self.dataset
        raise HTTPException(422, "dataset or dataset_parts required")


class MergeRequest(BaseModel):
    sources: list[MergeSourceRequest] = Field(
        ..., description="The datasets and the episodes selected from them"
    )
    name: str = Field("merged", description="Name of the merged dataset, used for the folder inside the zip")
    with_videos: bool = Field(True, description="Take the videos over as well (off: parquet and meta only)")


@app.post("/merge")
def merge(req: MergeRequest) -> Response:
    """
    The selected episodes of several datasets as **one** LeRobot dataset, zipped.

    This is what a finished gym session hands to training: the episodes of every
    upload that survived the selection, renumbered without gaps, with one task
    table and one ``meta/info.json``. The output is the v2.1 layout, whatever the
    sources were. Datasets that do not fit together (other fps, other features)
    are refused with 400 rather than merged into something unusable.

    The service does not keep the datasets: a source is normally a temporary URL
    the owning app hands over, it is fetched into the working directory of this
    one request, and everything goes when the response has been streamed.
    """
    import shutil
    import tempfile
    import zipfile

    from ..merge import MergeError, MergeSource, merge_datasets, merge_manifest

    if not req.sources:
        raise HTTPException(400, "no sources given")
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", req.name).strip("._") or "merged"
    from starlette.background import BackgroundTask

    work = Path(tempfile.mkdtemp(prefix="critics-merge-"))
    # the work area goes when the answer has been streamed, or at once when
    # there is no answer to stream
    streaming = False
    try:
        sources = []
        for i, src in enumerate(req.sources):
            if not src.episodes:
                continue
            source = src.source()
            label = src.name or source_label(source)
            try:
                # each source into its own directory of this request's work area,
                # so two sources cannot overwrite each other and everything goes
                # together in the finally below
                root = resolve_source(source, work / f"src{i}", DATA_DIR)
            except FileNotFoundError as e:
                raise HTTPException(404, f"dataset not found: {label}") from e
            except HTTPException:
                raise
            except Exception as e:  # noqa: BLE001
                raise HTTPException(502, f"could not fetch {label}: {type(e).__name__}") from e
            sources.append(MergeSource(root=root, episodes=sorted(set(src.episodes)), name=label))
        if not sources:
            raise HTTPException(400, "no episodes selected")
        try:
            result = merge_datasets(sources, work / stem, with_videos=req.with_videos)
        except MergeError as e:
            raise HTTPException(400, str(e)) from e

        manifest = merge_manifest(result, stem)
        (work / stem / "manifest.json").write_text(json.dumps(manifest, indent=2))
        archive = work / f"{stem}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:
            for f in sorted((work / stem).rglob("*")):
                if f.is_file():
                    z.write(f, f"{stem}/{f.relative_to(work / stem)}")
        # streamed from the disc, never read into memory: the selection of a
        # few datasets of several gigabytes each is a zip of the same order
        response = FileResponse(
            archive,
            media_type="application/zip",
            filename=f"{stem}.zip",
            headers={
                "X-Merged-Episodes": str(manifest["episodes"]),
                "X-Merged-Frames": str(manifest["frames"]),
            },
            background=BackgroundTask(shutil.rmtree, work, ignore_errors=True),
        )
        streaming = True
        return response
    finally:
        if not streaming:
            shutil.rmtree(work, ignore_errors=True)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "auth": bool(API_KEY),
        "version": __version__,
        "gemini_key": bool(os.environ.get("GEMINI_API_KEY")),
        "openrouter_key": bool(os.environ.get("OPENROUTER_API_KEY")),
        "jobs_dir": str(JOBS_DIR),
        "data_dir": str(DATA_DIR),
    }


@app.get("/critics")
def critics() -> list[dict[str, Any]]:
    return list_hard_critics()


@app.get("/metrics")
def metrics(critic: str | None = None) -> list[dict[str, Any]]:
    """What and how every hard-critic metric is measured (optionally for one critic)."""
    from ..metrics_doc import all_metric_docs

    return all_metric_docs(critic)


# ---------------------------------------------------------------- specs
@app.get("/specs")
def list_specs() -> list[dict[str, Any]]:
    out = []
    for p in sorted(SPECS_DIR.glob("*.yaml")):
        try:
            d = yaml.safe_load(p.read_text())
            out.append(
                {
                    "name": p.stem,
                    "task": d.get("task", {}).get("instruction"),
                    "robot": d.get("robot", {}).get("type"),
                }
            )
        except Exception:  # noqa: BLE001
            out.append({"name": p.stem, "error": "unreadable"})
    return out


@app.post("/specs", status_code=201)
def create_spec(spec: CriticSpec) -> dict[str, Any]:
    path = SPECS_DIR / f"{spec.name}.yaml"
    path.write_text(spec.to_yaml())
    return {"name": spec.name, "path": str(path)}


@app.post("/specs/auto")
def make_auto_spec(req: AutoSpecRequest) -> dict[str, Any]:
    p = Path(req.dataset)
    if not p.is_absolute():
        p = DATA_DIR / p
    if not p.is_dir():
        raise HTTPException(404, f"dataset dir not found: {p}")
    return json.loads(auto_spec(p, req.active_arms).model_dump_json())


@app.get("/specs/{name}")
def get_spec(name: str) -> dict[str, Any]:
    path = SPECS_DIR / f"{name}.yaml"
    if not path.is_file():
        raise HTTPException(404, "spec not found")
    return yaml.safe_load(path.read_text())


@app.put("/specs/{name}")
def put_spec(name: str, spec: CriticSpec) -> dict[str, Any]:
    spec.name = name
    (SPECS_DIR / f"{name}.yaml").write_text(spec.to_yaml())
    return {"name": name}


@app.delete("/specs/{name}", status_code=204)
def delete_spec(name: str) -> None:
    path = SPECS_DIR / f"{name}.yaml"
    if not path.is_file():
        raise HTTPException(404, "spec not found")
    path.unlink()


# ---------------------------------------------------------------- jobs
@app.post("/jobs", status_code=202)
def create_job(req: JobRequest) -> dict[str, Any]:
    jobs = []
    for ds in req.all_datasets():
        spec = _resolve_spec(req.spec, ds, req.purpose)
        job_id = store.submit(
            ds,
            spec,
            req.options,
            auto_spec_name=_auto_spec_name(ds),
            purpose=req.purpose,
            store_auto_spec=req.store_auto_spec,
        )
        # the parts of a dataset are links with a token each: the answer names them instead
        jobs.append(
            {"job_id": job_id, "dataset": ds if isinstance(ds, str) else source_label(ds), "status": "queued"}
        )
    if len(jobs) == 1:
        return jobs[0]
    return {"jobs": jobs}


@app.get("/jobs")
def list_jobs(limit: int = 50) -> list[dict[str, Any]]:
    return store.list(limit)


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    st = store.read(job_id)
    if st is None:
        raise HTTPException(404, "job not found")
    return st


@app.get("/jobs/{job_id}/spec", response_class=PlainTextResponse)
def job_spec(job_id: str) -> str:
    """The spec this job ran with, as YAML (also for 'auto' runs)."""
    p = store.root / job_id / "spec.yaml"
    if not p.is_file():
        raise HTTPException(404, "job or spec not found")
    return p.read_text()


@app.delete("/jobs/{job_id}", status_code=204)
def delete_job(job_id: str) -> None:
    if not store.delete(job_id):
        raise HTTPException(404, "job not found")


def _report_path(job_id: str, name: str) -> Path:
    st = store.read(job_id)
    if st is None:
        raise HTTPException(404, "job not found")
    if st.get("status") != "done":
        raise HTTPException(409, f"job status is {st.get('status')}")
    p = store.out_dir(job_id) / name
    if not p.is_file():
        raise HTTPException(404, f"{name} not found")
    return p


@app.get("/jobs/{job_id}/report")
def job_report(job_id: str) -> Any:
    return json.loads(_report_path(job_id, "report.json").read_text())


@app.get("/jobs/{job_id}/report.md", response_class=PlainTextResponse)
def job_report_md(job_id: str) -> str:
    return _report_path(job_id, "report.md").read_text()


@app.get("/jobs/{job_id}/report.html", response_class=HTMLResponse, include_in_schema=True)
def job_report_html(job_id: str, top: int = 5) -> str:
    """Visual report: overview with charts plus a detail analysis of the ``top`` worst episodes.

    A single self-contained HTML page (inline SVG charts, contact sheets embedded) with a print
    stylesheet - "Print -> Save as PDF" in the browser gives a handful of A4 pages.
    """
    from ..visual_report import render_html_report

    return render_html_report(
        _load_report(job_id),
        out_dir=store.out_dir(job_id),
        top_n=top,
        asset_base=f"/jobs/{job_id}/files/",
    )


def _markdown_response(text: str) -> Response:
    return Response(text, media_type="text/markdown; charset=utf-8")


def _load_report(job_id: str) -> DatasetReport:
    return DatasetReport.model_validate(json.loads(_report_path(job_id, "report.json").read_text()))


@app.get(
    "/jobs/{job_id}/markdown", response_class=Response, responses={200: {"content": {"text/markdown": {}}}}
)
def job_markdown(
    job_id: str,
    detail: Literal["summary", "flagged", "full"] = "full",
    episodes: str | None = None,
) -> Response:
    """The run as self-contained, AI-readable Markdown ("copy as Markdown").

    Explains the scoring, states the task and the checks that ran, adds a glossary of the
    flags and lists per-episode scores, flags, metrics, evidence and the VLM verdict as
    Markdown tables. ``detail``: summary | flagged (details for review/reject only) | full.
    ``episodes`` (e.g. ``0,3,7-9``) restricts the score table and the details to a subset.
    """
    try:
        subset = parse_episodes(episodes)
    except ValueError as e:
        raise HTTPException(422, f"bad episodes list {episodes!r}: {e}") from e
    return _markdown_response(render_ai_markdown(_load_report(job_id), detail=detail, episodes=subset))


class OverridesRequest(BaseModel):
    ignore_flags: list[str] = Field(
        default_factory=list, description="Findings to mute for this run: informational, as if never raised"
    )
    review_flags: list[str] = Field(
        default_factory=list,
        description="Findings that only cap an episode at review instead of rejecting it (a warning)",
    )
    disabled_critics: list[str] = Field(
        default_factory=list,
        description="Critics that do not apply to this dataset (ids such as tracking_error, or vlm for the "
        "whole model): no weight, no gate, no flags when the verdicts are replayed",
    )


@app.put("/jobs/{job_id}/overrides")
def put_job_overrides(job_id: str, req: OverridesRequest) -> dict[str, Any]:
    """Downgrade findings of a finished run and replay its verdicts.

    The critic results are what the run found and stay untouched; only the verdicts, the
    episode lists and selection.json are recomputed, so the overrides can be changed or taken
    back (two empty lists restore the run as scored). The report carries them in ``overrides``.
    """
    from ..report import write_reports
    from ..selection import apply_overrides

    report = apply_overrides(_load_report(job_id), req.ignore_flags, req.review_flags, req.disabled_critics)
    write_reports(report, store.out_dir(job_id))
    store.update_counts(job_id, report)
    return {
        "job_id": job_id,
        "overrides": report.overrides,
        "counts": report.counts,
        "include": report.include,
        "review": report.review,
        "exclude": report.exclude,
    }


@app.get("/jobs/{job_id}/selection")
def job_selection(job_id: str) -> Any:
    return json.loads(_report_path(job_id, "selection.json").read_text())


@app.get("/jobs/{job_id}/episodes/{episode}")
def job_episode(job_id: str, episode: int) -> Any:
    rep = json.loads(_report_path(job_id, "report.json").read_text())
    for e in rep.get("episodes", []):
        if e["episode"] == episode:
            return e
    raise HTTPException(404, "episode not in report")


@app.get(
    "/jobs/{job_id}/episodes/{episode}/markdown",
    response_class=Response,
    responses={200: {"content": {"text/markdown": {}}}},
)
def job_episode_markdown(job_id: str, episode: int) -> Response:
    """One episode (scores, flags with meaning, metrics, evidence, VLM verdict) as AI-readable Markdown."""
    try:
        return _markdown_response(render_episode_markdown(_load_report(job_id), episode))
    except KeyError as e:
        raise HTTPException(404, "episode not in report") from e


@app.get("/jobs/{job_id}/files/{path:path}")
def job_file(job_id: str, path: str) -> FileResponse:
    base = store.out_dir(job_id).resolve()
    p = (base / path).resolve()
    if not str(p).startswith(str(base)) or not p.is_file():
        raise HTTPException(404, "file not found")
    return FileResponse(p)


@app.post("/evaluate")
def evaluate(req: JobRequest, format: Literal["json", "markdown"] = "json") -> Any:
    """Blocking evaluation for small subsets (use /jobs for whole datasets). ``?format=markdown`` returns
    the AI-readable Markdown instead of report.json."""
    import shutil
    import tempfile

    from ..runner import run as _run

    dataset = req.all_datasets()[0]
    spec = _resolve_spec(req.spec, dataset, req.purpose)
    if req.options.episodes is None or len(req.options.episodes) > 10:
        raise HTTPException(400, "synchronous /evaluate is limited to <= 10 explicit episodes; use /jobs")
    # a working copy of this one request: a source that is a temporary URL is
    # fetched here and goes with the answer
    tmp = Path(tempfile.mkdtemp(prefix="critics-evaluate-", dir=JOBS_DIR))
    try:
        ds_path = resolve_source(dataset, tmp, DATA_DIR)
        if spec is None:
            spec = auto_spec(ds_path, purpose=req.purpose or "recording")
            spec.name = _auto_spec_name(dataset)
            (SPECS_DIR / f"{spec.name}.yaml").write_text(spec.to_yaml())
        opts = req.options.model_copy(update={"out_dir": str(tmp / "out"), "contact_sheets": False})
        report = _run(ds_path, spec, opts)
        if format == "markdown":
            return _markdown_response(render_ai_markdown(report, detail="full"))
        return json.loads(report.model_dump_json())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
