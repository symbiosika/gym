"""Simple persistent job store: one directory per job with status.json + outputs."""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..runner import RunOptions, run
from ..spec.models import CriticSpec, Purpose
from .sources import resolve_dataset as resolve_source


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class JobStore:
    def __init__(self, root: Path, data_root: Path, specs_root: Path | None = None):
        self.root = Path(root)
        self.data_root = Path(data_root)
        # an automatic spec is kept here so the run can be reproduced and the
        # spec refined afterwards; written by the job thread, see _run
        self.specs_root = Path(specs_root) if specs_root else self.root.parent / "specs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.specs_root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._threads: dict[str, threading.Thread] = {}

    # ------------------------------------------------------------ status io
    def _status_path(self, job_id: str) -> Path:
        return self.root / job_id / "status.json"

    def read(self, job_id: str) -> dict[str, Any] | None:
        p = self._status_path(job_id)
        if not p.is_file():
            return None
        # status.json is replaced atomically by _write; a reader can still race a writer on
        # filesystems without atomic rename semantics, so tolerate one transient bad read.
        for _ in range(3):
            try:
                text = p.read_text()
                if text.strip():
                    return json.loads(text)
            except (json.JSONDecodeError, OSError):
                pass
            time.sleep(0.02)
        return None

    def _write(self, job_id: str, **updates: Any) -> dict[str, Any]:
        with self._lock:
            st = self.read(job_id) or {"job_id": job_id}
            st.update(updates)
            st["updated_at"] = _now()
            path = self._status_path(job_id)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(st, indent=1))
            os.replace(tmp, path)  # atomic: readers see either the old or the new file, never a partial one
            return st

    def list(self, limit: int = 100) -> list[dict[str, Any]]:
        out = []
        for d in sorted(self.root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            st = self.read(d.name)
            if st:
                out.append(
                    {
                        k: st.get(k)
                        for k in (
                            "job_id",
                            "status",
                            "dataset",
                            "spec_name",
                            "created_at",
                            "updated_at",
                            "progress",
                            "counts",
                        )
                    }
                )
            if len(out) >= limit:
                break
        return out

    def delete(self, job_id: str) -> bool:
        d = self.root / job_id
        if not d.is_dir():
            return False
        shutil.rmtree(d)
        return True

    # ------------------------------------------------------------ dataset resolve
    def resolve_dataset(self, source: str, job_dir: Path) -> Path:
        """
        The dataset of this job, as a working copy inside the job directory.

        A source that is a temporary URL is fetched and unpacked here and
        nowhere else, so it lives exactly as long as the job does and goes with
        it when the job is deleted. See api/sources.py.
        """
        return resolve_source(source, job_dir, self.data_root)

    # ------------------------------------------------------------ run
    def submit(
        self,
        dataset: str,
        spec: CriticSpec | None,
        options: RunOptions,
        auto_spec_name: str = "auto",
        purpose: Purpose | None = None,
    ) -> str:
        """
        Start a job. `spec` of None means "generate one from the dataset": that
        needs the data, so it happens in the job thread and not here. A request
        that starts a job must come back at once, whatever the source is; a
        dataset behind a URL takes minutes to fetch and no proxy waits that long.
        `purpose` is what the generated spec is for (a resolved spec carries its own).
        """
        job_id = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_") + uuid.uuid4().hex[:6]
        job_dir = self.root / job_id
        job_dir.mkdir(parents=True)
        if spec is not None:
            (job_dir / "spec.yaml").write_text(spec.to_yaml())
        self._write(
            job_id,
            status="queued",
            dataset=dataset,
            spec_name=spec.name if spec is not None else auto_spec_name,
            created_at=_now(),
            progress={},
            options=options.model_dump(),
        )
        t = threading.Thread(
            target=self._run, args=(job_id, dataset, spec, options, auto_spec_name, purpose), daemon=True
        )
        self._threads[job_id] = t
        t.start()
        return job_id

    def _auto_spec(
        self, ds_path: Path, name: str, job_dir: Path, purpose: Purpose | None = None
    ) -> CriticSpec:
        """A starter spec from the dataset, kept under `name` so the run can be reproduced."""
        from ..spec.autospec import auto_spec

        generated = auto_spec(ds_path, purpose=purpose or "recording")
        generated.name = name
        (self.specs_root / f"{name}.yaml").write_text(generated.to_yaml())
        (job_dir / "spec.yaml").write_text(generated.to_yaml())
        return generated

    def _run(
        self,
        job_id: str,
        dataset: str,
        spec: CriticSpec | None,
        options: RunOptions,
        auto_spec_name: str = "auto",
        purpose: Purpose | None = None,
    ) -> None:
        job_dir = self.root / job_id
        try:
            self._write(job_id, status="preparing")
            ds_path = self.resolve_dataset(dataset, job_dir)
            if spec is None:
                spec = self._auto_spec(ds_path, auto_spec_name, job_dir, purpose)
                self._write(job_id, spec_name=spec.name)
            options = options.model_copy(update={"out_dir": str(job_dir / "out")})
            self._write(job_id, status="running", dataset_path=str(ds_path))

            def progress(stage: str, done: int, total: int) -> None:
                if done == total or done % 3 == 0:
                    st = self.read(job_id) or {}
                    prog = st.get("progress", {})
                    prog[stage] = {"done": done, "total": total}
                    self._write(job_id, progress=prog)

            report = run(ds_path, spec, options, progress=progress)
            self._write(
                job_id,
                status="done",
                counts=report.counts,
                include=report.include,
                review=report.review,
                exclude=report.exclude,
                timing_s=report.timing_s,
                n_episodes=report.n_episodes,
            )
        except Exception as e:  # noqa: BLE001
            self._write(
                job_id,
                status="failed",
                error=f"{type(e).__name__}: {e}",
                traceback=traceback.format_exc()[-4000:],
            )

    def update_counts(self, job_id: str, report: Any) -> None:
        """status.json follows a replayed report (PUT /jobs/{id}/overrides)."""
        self._write(
            job_id,
            counts=report.counts,
            include=report.include,
            review=report.review,
            exclude=report.exclude,
            n_episodes=report.n_episodes,
        )

    def out_dir(self, job_id: str) -> Path:
        return self.root / job_id / "out"
