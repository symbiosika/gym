"""Shared numeric helpers for hard critics."""

from __future__ import annotations

import numpy as np


def longest_run(mask: np.ndarray) -> int:
    best = cur = 0
    for v in mask:
        cur = cur + 1 if v else 0
        if cur > best:
            best = cur
    return int(best)


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """(start, end_exclusive) of every True run."""
    out = []
    n = len(mask)
    i = 0
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            out.append((i, j))
            i = j
        else:
            i += 1
    return out


def smooth(x: np.ndarray, k: int) -> np.ndarray:
    if k <= 1 or len(x) < k:
        return x.astype(float)
    pad = np.pad(x.astype(float), (k // 2, k - 1 - k // 2), mode="edge")
    return np.convolve(pad, np.ones(k) / k, mode="valid")


def rot6d_to_matrix(r: np.ndarray) -> np.ndarray:
    """(N, 6) continuous 6-D rotation (two columns) -> (N, 3, 3) via Gram-Schmidt."""
    a1 = r[:, 0:3]
    a2 = r[:, 3:6]
    b1 = a1 / np.maximum(np.linalg.norm(a1, axis=1, keepdims=True), 1e-9)
    a2p = a2 - (b1 * a2).sum(1, keepdims=True) * b1
    b2 = a2p / np.maximum(np.linalg.norm(a2p, axis=1, keepdims=True), 1e-9)
    b3 = np.cross(b1, b2)
    return np.stack([b1, b2, b3], axis=2)


def rotation_angle_deg(ra: np.ndarray, rb: np.ndarray) -> np.ndarray:
    """Geodesic angle between two (N,3,3) rotation batches, in degrees."""
    rel = np.einsum("nij,nkj->nik", ra, rb)  # ra @ rb^T
    tr = np.clip((np.trace(rel, axis1=1, axis2=2) - 1.0) / 2.0, -1.0, 1.0)
    return np.degrees(np.arccos(tr))


def quat_angle_deg(qa: np.ndarray, qb: np.ndarray) -> np.ndarray:
    qa = qa / np.maximum(np.linalg.norm(qa, axis=1, keepdims=True), 1e-9)
    qb = qb / np.maximum(np.linalg.norm(qb, axis=1, keepdims=True), 1e-9)
    d = np.clip(np.abs((qa * qb).sum(1)), 0.0, 1.0)
    return np.degrees(2 * np.arccos(d))


def orientation_error_deg(a: np.ndarray, s: np.ndarray) -> np.ndarray | None:
    """Orientation error for a cartesian pose vector after xyz: rot6d (9-D), quaternion
    (7-D) or euler rpy (6-D)."""
    d = a.shape[1]
    if d == 9:
        return rotation_angle_deg(rot6d_to_matrix(a[:, 3:9]), rot6d_to_matrix(s[:, 3:9]))
    if d == 7:
        return quat_angle_deg(a[:, 3:7], s[:, 3:7])
    if d == 6:
        diff = np.abs(((a[:, 3:6] - s[:, 3:6]) + np.pi) % (2 * np.pi) - np.pi)
        return np.degrees(np.linalg.norm(diff, axis=1))
    return None


def log_dimensionless_jerk(pos: np.ndarray, dt: float) -> float | None:
    """LDJ of a 1-D or 3-D trajectory segment; larger (less negative) = smoother."""
    if pos.ndim == 1:
        pos = pos[:, None]
    v = np.gradient(pos, dt, axis=0)
    speed = np.linalg.norm(v, axis=1)
    v_peak = float(speed.max())
    if v_peak < 1e-6 or len(pos) < 8:
        return None
    a = np.gradient(v, dt, axis=0)
    j = np.gradient(a, dt, axis=0)
    dur = len(pos) * dt
    dlj = (dur**5 / v_peak**2) * float(np.trapezoid((j**2).sum(1), dx=dt))
    return -float(np.log(max(dlj, 1e-12)))


def windowed_ldj(pos: np.ndarray, dt: float, window_s: float = 3.0, min_speed: float = 0.02) -> list[float]:
    """LDJ over consecutive windows that contain real motion -> duration-independent."""
    w = max(8, int(round(window_s / dt)))
    out = []
    for s0 in range(0, len(pos) - w + 1, w // 2):
        seg = pos[s0 : s0 + w]
        sp = (
            np.linalg.norm(np.gradient(seg, dt, axis=0), axis=1)
            if seg.ndim == 2
            else np.abs(np.gradient(seg, dt))
        )
        if sp.max() < min_speed:
            continue
        v = log_dimensionless_jerk(seg, dt)
        if v is not None:
            out.append(v)
    return out


def high_freq_ratio(sig: np.ndarray, fs: float, cutoff_hz: float) -> float | None:
    """Fraction of (mean-removed) signal energy above ``cutoff_hz``."""
    x = sig - sig.mean()
    if len(x) < 16 or not np.any(x):
        return None
    spec = np.abs(np.fft.rfft(x)) ** 2
    freqs = np.fft.rfftfreq(len(x), d=1.0 / fs)
    tot = spec[1:].sum()
    if tot <= 0:
        return None
    return float(spec[freqs >= cutoff_hz].sum() / tot)


def robust_scale(x: np.ndarray) -> float:
    med = np.median(x)
    mad = np.median(np.abs(x - med))
    return float(1.4826 * mad) if mad > 0 else float(np.mean(np.abs(x - med)) + 1e-12)


def welch_psd(x: np.ndarray, fs: float, nperseg: int = 256) -> tuple[np.ndarray, np.ndarray]:
    """Welch power spectral density of a 1-D or (N, D) signal (summed over D), Hann window,
    50 % overlap. Returns (freqs, power). numpy only."""
    x = np.asarray(x, dtype=float)
    if x.ndim == 1:
        x = x[:, None]
    n = len(x)
    nperseg = int(min(nperseg, n))
    if nperseg < 8:
        return np.array([]), np.array([])
    x = x - x.mean(0)
    win = np.hanning(nperseg)
    step = max(1, nperseg // 2)
    acc = None
    count = 0
    for s0 in range(0, n - nperseg + 1, step):
        seg = x[s0 : s0 + nperseg] * win[:, None]
        p = (np.abs(np.fft.rfft(seg, axis=0)) ** 2).sum(1)
        acc = p if acc is None else acc + p
        count += 1
    if acc is None or count == 0:
        return np.array([]), np.array([])
    freqs = np.fft.rfftfreq(nperseg, d=1.0 / fs)
    return freqs, acc / count


def band_share(freqs: np.ndarray, power: np.ndarray, lo: float, floor: float = 0.3) -> float | None:
    """Share of the power above ``lo`` Hz relative to everything above ``floor`` Hz."""
    if len(freqs) == 0:
        return None
    tot = float(power[freqs > floor].sum())
    if tot <= 0:
        return None
    return float(power[freqs > lo].sum() / tot)


def spectral_peak(freqs: np.ndarray, power: np.ndarray, above_hz: float) -> float | None:
    """Frequency of the strongest PSD bin above ``above_hz``."""
    if len(freqs) == 0:
        return None
    m = freqs > above_hz
    if not m.any():
        return None
    return float(freqs[m][int(np.argmax(power[m]))])


def xcorr_lag(cmd: np.ndarray, state: np.ndarray, max_lag: int) -> tuple[float, float] | None:
    """Delay (frames, sub-frame) at which ``state`` best follows ``cmd``, from the normalised
    cross-correlation of two 1-D signals (use velocities, not positions). Returns
    (lag_frames, correlation_at_peak); None when a signal is flat.

    The integer peak is refined by parabolic interpolation over its two neighbours, which
    gives a resolution well below one frame for smooth peaks.
    """
    c = np.asarray(cmd, dtype=float)
    s = np.asarray(state, dtype=float)
    n = min(len(c), len(s))
    if n < 16:
        return None
    c, s = c[:n], s[:n]
    if c.std() < 1e-12 or s.std() < 1e-12:
        return None
    c = (c - c.mean()) / c.std()
    s = (s - s.mean()) / s.std()
    max_lag = int(min(max_lag, n // 4))
    corr = np.array([np.mean(c[: n - k] * s[k:]) for k in range(0, max_lag + 1)])
    k = int(np.argmax(corr))
    frac = 0.0
    if 0 < k < len(corr) - 1:
        y0, y1, y2 = corr[k - 1], corr[k], corr[k + 1]
        denom = y0 - 2 * y1 + y2
        if abs(denom) > 1e-12:
            frac = float(np.clip(0.5 * (y0 - y2) / denom, -0.5, 0.5))
    return float(k + frac), float(corr[k])


def detrended_std(pos: np.ndarray) -> float:
    """Standard deviation of the 3-D position after removing a linear trend per axis
    (jitter around a slow drift)."""
    n = len(pos)
    if n < 3:
        return 0.0
    t = np.arange(n, dtype=float)
    res = np.empty_like(pos, dtype=float)
    for k in range(pos.shape[1]):
        coef = np.polyfit(t, pos[:, k], 1)
        res[:, k] = pos[:, k] - np.polyval(coef, t)
    return float(np.linalg.norm(res, axis=1).std())
