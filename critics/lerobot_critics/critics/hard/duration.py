"""Duration / step count."""

from __future__ import annotations

from ...dataset.loader import EpisodeContext
from ..base import HardCritic, band
from ..registry import register


@register
class DurationCritic(HardCritic):
    id = "duration"
    description = (
        "Episode length in seconds against [min_s, max_s]; outside the band the score falls linearly to 0 "
        "over margin_frac of the bound. Also flags dataset-relative SHORT/LONG outliers."
    )
    default_params = {
        "min_s": 5.0,
        "max_s": 300.0,
        "margin_frac": 0.5,  # score reaches 0 at min_s*(1-margin) / max_s*(1+margin)
        "per_cycle": False,  # when true and task.expected_cycles is set, bounds apply per cycle
    }
    relative_flags = {"duration_s": ("LONG_OUTLIER", +1), "neg_duration_s": ("SHORT_OUTLIER", +1)}

    def evaluate(self, ep: EpisodeContext):
        d = ep.duration_s
        lo, hi = float(self.p("min_s")), float(self.p("max_s"))
        cycles = self.spec.task.expected_cycles
        if self.p("per_cycle") and cycles:
            lo, hi = lo * cycles, hi * cycles
        mf = float(self.p("margin_frac"))
        score = band(d, lo, hi, lo * mf, hi * mf)
        flags = []
        ev = []
        if d < lo:
            flags.append("TOO_SHORT")
            ev.append(f"{d:.1f}s < min {lo:.1f}s")
        elif d > hi:
            flags.append("TOO_LONG")
            ev.append(f"{d:.1f}s > max {hi:.1f}s")
        return self.result(
            score,
            {
                "duration_s": d,
                "neg_duration_s": -d,
                "frames": ep.length,
                "fps": ep.fps,
                "min_s": lo,
                "max_s": hi,
            },
            flags,
            ev,
        )
