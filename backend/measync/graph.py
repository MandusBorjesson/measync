from __future__ import annotations

import numpy as np

EMPTY_BAND = {"t": [], "mean": [], "min": [], "max": []}
GRAPH_POINTS = 100
GRAPH_POINTS_MIN = 16
GRAPH_POINTS_MAX = 2000


def clamp_graph_points(value: int | None) -> int:
    if value is None:
        return GRAPH_POINTS
    try:
        n = int(value)
    except (TypeError, ValueError):
        return GRAPH_POINTS
    return max(GRAPH_POINTS_MIN, min(GRAPH_POINTS_MAX, n))


def _as_float(y: np.ndarray | list) -> np.ndarray:
    arr = np.asarray(y, dtype=np.float64)
    if arr.dtype == object:
        out = np.empty(len(y), dtype=np.float64)
        for i, value in enumerate(y):
            out[i] = np.nan if value is None else float(value)
        return out
    return arr


def _nullable(values: np.ndarray) -> list[float | None]:
    out: list[float | None] = []
    for value in values:
        out.append(None if not np.isfinite(value) else float(value))
    return out


def raw_band(ts: np.ndarray, ys: np.ndarray) -> dict[str, list]:
    vals = _nullable(_as_float(ys))
    return {
        "t": [int(v) for v in np.asarray(ts, dtype=np.int64)],
        "mean": vals,
        "min": list(vals),
        "max": list(vals),
        "raw": True,
    }


def gather_window(
    ts: np.ndarray,
    ys: np.ndarray,
    t0: int,
    t1: int,
    *,
    drop_nan: bool = True,
) -> tuple[np.ndarray, np.ndarray]:
    ts = np.asarray(ts, dtype=np.int64)
    ys = _as_float(ys)
    n = min(int(ts.size), int(ys.size))
    if n <= 0:
        return ts[:0], ys[:0]
    ts = ts[:n]
    ys = ys[:n]
    keep = (ts >= t0) & (ts <= t1)
    if drop_nan:
        keep = keep & np.isfinite(ys)
    ts = ts[keep]
    ys = ys[keep]
    if ts.size <= 1:
        return ts, ys
    order = np.argsort(ts, kind="stable")
    return ts[order], ys[order]


def align_window(
    ts: np.ndarray,
    channels: list[np.ndarray],
    t0: int,
    t1: int,
) -> tuple[np.ndarray, list[np.ndarray]]:
    ts = np.asarray(ts, dtype=np.int64)
    arrs = [_as_float(ch) for ch in channels]
    n = int(ts.size)
    for arr in arrs:
        n = min(n, int(arr.size))
    ts = ts[:n]
    arrs = [arr[:n] for arr in arrs]
    keep = (ts >= t0) & (ts <= t1)
    ts = ts[keep]
    arrs = [arr[keep] for arr in arrs]
    if ts.size <= 1:
        return ts, arrs
    order = np.argsort(ts, kind="stable")
    return ts[order], [arr[order] for arr in arrs]


class SeriesBuckets:
    """Absolute-time mean/min/max bins. Bucket edges do not move when the window pans."""

    def __init__(self, t0: int, t1: int, max_points: int = GRAPH_POINTS) -> None:
        self.t0 = int(t0)
        self.t1 = int(t1)
        n = max(1, int(max_points))
        self.span = max(1, self.t1 - self.t0)
        self.width = max(1, (self.span + n - 1) // n)
        first = self.t0 // self.width
        last = self.t1 // self.width
        self.origin = int(first * self.width)
        self.n = int(last - first + 1)
        self._sum = np.zeros(self.n, dtype=np.float64)
        self._min = np.full(self.n, np.inf, dtype=np.float64)
        self._max = np.full(self.n, -np.inf, dtype=np.float64)
        self._count = np.zeros(self.n, dtype=np.int64)
        self._t = np.full(self.n, np.iinfo(np.int64).max, dtype=np.int64)

    def add(self, ts: np.ndarray, ys: np.ndarray) -> None:
        ts = np.asarray(ts, dtype=np.int64)
        ys = _as_float(ys)
        n = min(int(ts.size), int(ys.size))
        if n <= 0:
            return
        ts = ts[:n]
        ys = ys[:n]
        in_win = (ts >= self.t0) & (ts <= self.t1) & np.isfinite(ys)
        if not np.any(in_win):
            return
        ts = ts[in_win]
        ys = ys[in_win]
        idx = (ts - self.origin) // self.width
        valid = (idx >= 0) & (idx < self.n)
        if not np.any(valid):
            return
        idx = idx[valid]
        ys = ys[valid]
        np.add.at(self._sum, idx, ys)
        np.minimum.at(self._min, idx, ys)
        np.maximum.at(self._max, idx, ys)
        np.add.at(self._count, idx, 1)
        np.minimum.at(self._t, idx, ts)

    def occupied(self) -> np.ndarray:
        return self._count > 0

    def finish(self, occ: np.ndarray | None = None) -> dict[str, list]:
        filled = self.occupied()
        mask = filled if occ is None else np.asarray(occ, dtype=bool)
        if mask.size != self.n:
            mask = filled
        if not np.any(mask):
            return {**EMPTY_BAND, "raw": False}
        centers = self.origin + self.width // 2 + np.arange(self.n, dtype=np.int64) * self.width
        sample_t = np.where(self._count == 1, self._t, centers)
        mean = np.full(self.n, np.nan, dtype=np.float64)
        lo = np.full(self.n, np.nan, dtype=np.float64)
        hi = np.full(self.n, np.nan, dtype=np.float64)
        if np.any(filled):
            mean[filled] = self._sum[filled] / self._count[filled]
            collapsed = self._count > 1
            lo[filled] = np.where(collapsed[filled], self._min[filled], mean[filled])
            hi[filled] = np.where(collapsed[filled], self._max[filled], mean[filled])
        return {
            "t": [int(v) for v in sample_t[mask]],
            "mean": _nullable(mean[mask]),
            "min": _nullable(lo[mask]),
            "max": _nullable(hi[mask]),
            "raw": False,
        }


def bucket_series(
    t: np.ndarray | list,
    y: np.ndarray | list,
    t0: int,
    t1: int,
    max_points: int = GRAPH_POINTS,
) -> dict[str, list]:
    """Downsample a scalar series to at most max_points.

    When several samples collapse into one point, return the mean plus min/max
    of that bucket. When the window itself has at most max_points samples, return
    those samples at their real timestamps (no binning). Missing values (None / NaN)
    are omitted; empty buckets are skipped so the line can gap. Bucket edges are
    locked to an absolute time grid so a pan does not reshuffle which sample sits
    in which bin.
    """
    ts = np.asarray(t, dtype=np.int64)
    ys = _as_float(y)
    n = min(int(ts.size), int(ys.size))
    if n <= 0:
        return {**EMPTY_BAND, "raw": False}
    ts = ts[:n]
    ys = ys[:n]
    in_win = int(np.count_nonzero((ts >= t0) & (ts <= t1)))
    if in_win <= max(1, int(max_points)):
        ts, ys = gather_window(ts, ys, t0, t1)
        return raw_band(ts, ys)
    buckets = SeriesBuckets(t0, t1, max_points)
    buckets.add(ts, ys)
    return buckets.finish()


def band_from_values(t: list[int], mean: list, lo: list, hi: list) -> dict[str, list]:
    return {"t": t, "mean": mean, "min": lo, "max": hi}
