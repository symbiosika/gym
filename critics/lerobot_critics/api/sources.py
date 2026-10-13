"""Where a dataset comes from, and where it goes when the work is done.

The service does not keep the datasets it analyses. The app that owns them
stores them and hands over a temporary URL instead of the bytes: a presigned
link of an object store, or a signed link of the app itself. The critics fetch
what they need for the piece of work in front of them, use it, and leave
nothing behind.

So a source is resolved into a working copy that belongs to one job or one
merge, and dies with it:

    http(s) URL   the zip is streamed to disc, extracted, and the zip is
                  deleted straight away. Only the extracted dataset stays, for
                  as long as the work runs.
    local path    a directory is used where it lies, a zip is extracted next to
                  the work. This is what the CLI and a developer use.
    hf repo id    downloaded through huggingface_hub, if it is installed.

`CRITICS_DATA_DIR` is still the root a bare name is resolved against, for the
CLI, the web UI and anything that put a dataset there by hand. Nothing the
service does on its own writes into it any more.
"""

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

#: How much of a download is held in memory at once.
_CHUNK = 1 << 20

#: Prefixes that mean "fetch this over HTTP".
URL_PREFIXES = ("http://", "https://")


def is_url(source: str) -> bool:
    return source.startswith(URL_PREFIXES)


def extract_dataset(zip_path: Path, dest: Path) -> Path:
    """Unpack a zipped LeRobot dataset and return the directory that is the dataset."""
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(dest)
    infos = list(dest.rglob("meta/info.json"))
    if not infos:
        raise FileNotFoundError("zip does not contain a LeRobot dataset (meta/info.json)")
    return infos[0].parent.parent


def download_dataset(url: str, work_dir: Path) -> Path:
    """
    Fetch a zipped dataset and unpack it under `work_dir`.

    The archive is deleted as soon as it is unpacked: it is worth nothing once
    the dataset is on disc, and a dataset is large enough that keeping both
    would double what the service needs.

    The URL is expected to be temporary and to carry its own permission (a
    presigned object-store link, or a signed link of the app), so it is never
    written to a status file or a log.
    """
    import httpx

    work_dir.mkdir(parents=True, exist_ok=True)
    archive = work_dir / "download.zip"
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=None) as r:
            r.raise_for_status()
            with archive.open("wb") as f:
                for chunk in r.iter_bytes(_CHUNK):
                    f.write(chunk)
        return extract_dataset(archive, work_dir / "dataset")
    finally:
        archive.unlink(missing_ok=True)


def resolve_dataset(source: str, work_dir: Path, data_root: Path) -> Path:
    """A local path, a temporary http(s) URL to a zip, or a HF hub repo id."""
    if is_url(source):
        return download_dataset(source, work_dir)

    p = Path(source)
    if not p.is_absolute():
        p = data_root / p
    if p.is_file() and p.suffix == ".zip":
        return extract_dataset(p, work_dir / "dataset")
    if p.is_dir():
        return p
    if "/" in source and not source.startswith("/"):
        try:
            from huggingface_hub import snapshot_download

            return Path(
                snapshot_download(repo_id=source, repo_type="dataset", local_dir=str(work_dir / "dataset"))
            )
        except ImportError as e:  # pragma: no cover
            raise FileNotFoundError(
                f"{source} is not a local dataset and huggingface_hub is not installed"
            ) from e
    raise FileNotFoundError(f"dataset not found: {source}")


def source_label(source: str) -> str:
    """
    A name for a source that is safe to show and to log.

    A temporary URL carries a token, so it is never shown; what is left is the
    last part of its path, which is the object's name.
    """
    if is_url(source):
        from urllib.parse import urlparse

        name = Path(urlparse(source).path).name
        return name or "dataset"
    return Path(source.rstrip("/")).name or "dataset"


def discard(path: Path) -> None:
    """Remove a working copy. A missing one is fine."""
    shutil.rmtree(path, ignore_errors=True)
