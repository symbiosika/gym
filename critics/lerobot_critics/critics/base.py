"""Critic base classes and the result record shared by hard and soft critics."""

from __future__ import annotations

from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

from ..dataset.loader import EpisodeContext
from ..spec.models import CriticSpec, HardCriticConfig


class CriticResult(BaseModel):
    id: str
    kind: Literal["hard", "soft"]
    weight: float = 1.0
    score: float | None = Field(None, description="0 (bad) .. 1 (good); None = not applicable / no data")
    gate: bool = False
    gate_below: float = 0.0
    gate_failed: bool = False
    flags: list[str] = Field(default_factory=list)
    metrics: dict[str, Any] = Field(default_factory=dict)
    evidence: list[str] = Field(default_factory=list)
    error: str | None = None

    @property
    def applicable(self) -> bool:
        return self.score is not None and self.error is None


def clamp01(x: float) -> float:
    return float(min(1.0, max(0.0, x)))


def ramp(x: float | None, good: float, bad: float) -> float | None:
    """1.0 when ``x <= good``, 0.0 when ``x >= bad``, linear in between (lower is better)."""
    if x is None:
        return None
    if bad <= good:
        return 1.0 if x <= good else 0.0
    return clamp01(1.0 - (x - good) / (bad - good))


def ramp_high(x: float | None, good: float, bad: float) -> float | None:
    """1.0 when ``x >= good``, 0.0 when ``x <= bad`` (higher is better)."""
    if x is None:
        return None
    if good <= bad:
        return 1.0 if x >= good else 0.0
    return clamp01((x - bad) / (good - bad))


def band(x: float | None, lo: float, hi: float, margin_lo: float, margin_hi: float) -> float | None:
    """1.0 inside [lo, hi], falling to 0.0 at lo - margin_lo / hi + margin_hi."""
    if x is None:
        return None
    if x < lo:
        return ramp(lo - x, 0.0, margin_lo)
    if x > hi:
        return ramp(x - hi, 0.0, margin_hi)
    return 1.0


class HardCritic:
    """A deterministic per-episode check.

    Subclasses set ``id``, ``description``, ``default_params`` and implement
    :meth:`evaluate`. ``finalize`` runs once after all episodes and may add
    dataset-relative flags.
    """

    id: ClassVar[str] = "base"
    description: ClassVar[str] = ""
    default_params: ClassVar[dict[str, Any]] = {}
    # metric keys that get robust-z outlier flags in finalize(): {metric: (flag, direction)}
    relative_flags: ClassVar[dict[str, tuple[str, int]]] = {}

    def __init__(self, cfg: HardCriticConfig, spec: CriticSpec):
        self.cfg = cfg
        self.spec = spec
        self.params: dict[str, Any] = {**self.default_params, **(cfg.params or {})}

    # -- helpers ----------------------------------------------------------
    def p(self, key: str, default: Any = None) -> Any:
        return self.params.get(key, default)

    def result(
        self,
        score: float | None,
        metrics: dict[str, Any] | None = None,
        flags: list[str] | None = None,
        evidence: list[str] | None = None,
        error: str | None = None,
    ) -> CriticResult:
        from ..scoring import mute_flags

        score = None if score is None else clamp01(score)
        # findings switched off in the spec never reach a gate, a review cap or a report
        flags = mute_flags(flags, self.spec.scoring)
        gate_failed = bool(self.cfg.gate and score is not None and score < self.cfg.gate_below)
        if self.cfg.gate_flags and set(self.cfg.gate_flags) & set(flags):
            gate_failed = True
        return CriticResult(
            id=self.id,
            kind="hard",
            weight=self.cfg.weight,
            score=score,
            gate=self.cfg.gate or bool(self.cfg.gate_flags),
            gate_below=self.cfg.gate_below,
            gate_failed=gate_failed,
            flags=list(flags),
            metrics=_jsonable(metrics or {}),
            evidence=list(evidence or []),
            error=error,
        )

    # -- API ---------------------------------------------------------------
    def evaluate(self, ep: EpisodeContext) -> CriticResult:  # pragma: no cover - abstract
        raise NotImplementedError

    def safe_evaluate(self, ep: EpisodeContext) -> CriticResult:
        try:
            return self.evaluate(ep)
        except Exception as e:  # noqa: BLE001 - a broken critic must not kill the run
            return self.result(None, error=f"{type(e).__name__}: {e}")

    def summarize(self, results: list[CriticResult]) -> dict[str, Any] | None:
        """Dataset-level summary computed once after ``finalize`` (optional).

        Returns a JSON-able dict that lands in ``DatasetReport.dataset_summaries[critic id]``.
        A ``"flags"`` entry of the form ``{FLAG: explanation}`` is lifted into
        ``DatasetReport.dataset_flags``: run-level findings (a dataset with no spatial
        diversity, corrupted normalisation statistics) that are not the fault of any single
        episode. The runner sets ``self.ds`` (the open dataset) before calling this.
        """
        return None

    def finalize(self, results: list[CriticResult], z_cut: float) -> None:
        """Default: robust-z flags for the metrics listed in ``relative_flags``."""
        if not self.relative_flags or len(results) < 6:
            return
        import numpy as np

        from ..scoring import robust_z

        ignored = set(self.spec.scoring.ignore_flags)
        for key, (flag, direction) in self.relative_flags.items():
            if flag in ignored:
                continue
            vals = np.array(
                [
                    r.metrics.get(key) if isinstance(r.metrics.get(key), (int, float)) else np.nan
                    for r in results
                ],
                dtype=float,
            )
            if np.isnan(vals).all():
                continue
            z = robust_z(vals) * direction
            for r, zi in zip(results, z, strict=False):
                if np.isfinite(zi) and zi > z_cut and flag not in r.flags:
                    r.flags.append(flag)
                    r.metrics[f"z.{key}"] = float(zi)


def _jsonable(obj: Any) -> Any:
    import numpy as np

    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, np.generic):
        v = obj.item()
        return None if isinstance(v, float) and v != v else v
    if isinstance(obj, np.ndarray):
        return _jsonable(obj.tolist())
    if isinstance(obj, float) and obj != obj:
        return None
    return obj
