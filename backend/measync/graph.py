from __future__ import annotations

from bisect import bisect_left, bisect_right

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


BIN_NS = 50_000_000


class IngestBins:
    """Fixed-width absolute grid filled as samples arrive.

    Only the open newest bin mutates. Sealed bins never change their sample set.
    """

    def __init__(self, n_ch: int = 1, width_ns: int = BIN_NS) -> None:
        self.n_ch = max(1, int(n_ch))
        self.width = max(1, int(width_ns))
        self.start = 0
        self.t: list[int] = []
        self.last_t: list[int] = []
        self.bin_id: list[int] = []
        self.counts: list[list[int]] = [[] for _ in range(self.n_ch)]
        self.sums: list[list[float]] = [[] for _ in range(self.n_ch)]
        self.mins: list[list[float]] = [[] for _ in range(self.n_ch)]
        self.maxs: list[list[float]] = [[] for _ in range(self.n_ch)]

    def copy(self) -> IngestBins:
        other = IngestBins(self.n_ch, self.width)
        sl = slice(self.start, None)
        other.t = list(self.t[sl])
        other.last_t = list(self.last_t[sl])
        other.bin_id = list(self.bin_id[sl])
        other.counts = [list(ch[sl]) for ch in self.counts]
        other.sums = [list(ch[sl]) for ch in self.sums]
        other.mins = [list(ch[sl]) for ch in self.mins]
        other.maxs = [list(ch[sl]) for ch in self.maxs]
        return other

    def add(self, ts: np.ndarray, *channels: np.ndarray) -> None:
        ts = np.asarray(ts, dtype=np.int64)
        ys = [_as_float(ch) for ch in channels[: self.n_ch]]
        n = int(ts.size)
        for arr in ys:
            n = min(n, int(arr.size))
        if n <= 0:
            return
        ts = ts[:n]
        ys = [arr[:n] for arr in ys]
        ids = ts // self.width
        breaks = np.flatnonzero(ids[1:] != ids[:-1]) + 1
        starts = np.concatenate((np.array([0], dtype=np.int64), breaks))
        ends = np.concatenate((breaks, np.array([n], dtype=np.int64)))
        for a, b in zip(starts.tolist(), ends.tolist(), strict=True):
            bid = int(ids[a])
            open_id = self.bin_id[-1] if self.start < len(self.bin_id) else None
            if open_id is not None and bid < open_id:
                continue
            if open_id != bid:
                self._open(bid, int(ts[a]))
            idx = len(self.t) - 1
            last = int(ts[b - 1])
            if last > self.last_t[idx]:
                self.last_t[idx] = last
            for ch, arr in enumerate(ys):
                sl = arr[a:b]
                finite = sl[np.isfinite(sl)]
                if finite.size == 0:
                    continue
                self.counts[ch][idx] += int(finite.size)
                self.sums[ch][idx] += float(finite.sum())
                lo = float(finite.min())
                hi = float(finite.max())
                if self.counts[ch][idx] == int(finite.size):
                    self.mins[ch][idx] = lo
                    self.maxs[ch][idx] = hi
                else:
                    if lo < self.mins[ch][idx]:
                        self.mins[ch][idx] = lo
                    if hi > self.maxs[ch][idx]:
                        self.maxs[ch][idx] = hi

    def _open(self, bid: int, first_t: int) -> None:
        self.t.append(int(first_t))
        self.last_t.append(int(first_t))
        self.bin_id.append(int(bid))
        for ch in range(self.n_ch):
            self.counts[ch].append(0)
            self.sums[ch].append(0.0)
            self.mins[ch].append(0.0)
            self.maxs[ch].append(0.0)

    def pop_while_at_or_before(self, horizon_ns: int) -> None:
        while self.start < len(self.last_t) and self.last_t[self.start] <= horizon_ns:
            self.start += 1
        if self.start > 1024 and self.start * 2 >= len(self.t):
            sl = slice(self.start, None)
            self.t = self.t[sl]
            self.last_t = self.last_t[sl]
            self.bin_id = self.bin_id[sl]
            self.counts = [ch[sl] for ch in self.counts]
            self.sums = [ch[sl] for ch in self.sums]
            self.mins = [ch[sl] for ch in self.mins]
            self.maxs = [ch[sl] for ch in self.maxs]
            self.start = 0

    def window(self, t0: int, t1: int) -> tuple[int, int]:
        if self.start >= len(self.t):
            return self.start, self.start
        i0 = bisect_left(self.last_t, t0, self.start)
        i1 = bisect_right(self.t, t1, self.start)
        return i0, max(i1, i0)

    def _occupied(self, a: int, b: int) -> bool:
        return any(self.counts[ch][i] > 0 for ch in range(self.n_ch) for i in range(a, b))

    def _groups(self, t0: int, t1: int, max_points: int) -> list[tuple[int, int]]:
        i0, i1 = self.window(t0, t1)
        if i1 <= i0:
            return []
        n = i1 - i0
        dest = max(1, int(max_points))
        if n <= dest:
            return [(i, i + 1) for i in range(i0, i1)]
        groups: list[tuple[int, int]] = []
        for k in range(dest):
            a = i0 + k * n // dest
            b = i0 + (k + 1) * n // dest
            if b > a:
                groups.append((a, b))
        return groups

    def _kept_groups(self, t0: int, t1: int, max_points: int) -> list[tuple[int, int]]:
        return [pair for pair in self._groups(t0, t1, max_points) if self._occupied(*pair)]

    def _group_t(self, a: int, b: int) -> int:
        total = sum(self.counts[ch][i] for ch in range(self.n_ch) for i in range(a, b))
        if total <= 1:
            return self.t[a]
        if b == a + 1:
            return int(self.bin_id[a] * self.width + self.width // 2)
        return (self.t[a] + self.last_t[b - 1]) // 2

    def emit(self, t0: int, t1: int, max_points: int = GRAPH_POINTS) -> list[dict[str, list]]:
        empty = [{**EMPTY_BAND, "raw": False} for _ in range(self.n_ch)]
        kept = self._kept_groups(t0, t1, max_points)
        if not kept:
            return empty
        ts: list[int] = []
        bands = [{"mean": [], "min": [], "max": []} for _ in range(self.n_ch)]
        for a, b in kept:
            ts.append(self._group_t(a, b))
            for ch in range(self.n_ch):
                _t, m, mn, mx = self._fold(ch, a, b)
                bands[ch]["mean"].append(m)
                bands[ch]["min"].append(mn)
                bands[ch]["max"].append(mx)
        return [{**band, "t": ts, "raw": False} for band in bands]

    def project(self, ts: np.ndarray | list, ys: np.ndarray | list, t0: int, t1: int, max_points: int = GRAPH_POINTS) -> dict[str, list]:
        """Fold extra samples onto this ingest grid so they share emit timestamps."""
        kept = self._kept_groups(t0, t1, max_points)
        if not kept:
            return {**EMPTY_BAND, "raw": False}
        lo_i = kept[0][0]
        hi_i = kept[-1][1]
        n = hi_i - lo_i
        cnt = [0] * n
        acc = [0.0] * n
        mn = [0.0] * n
        mx = [0.0] * n
        id_to_off = {self.bin_id[i]: i - lo_i for i in range(lo_i, hi_i)}
        src_t = np.asarray(ts, dtype=np.int64)
        src_y = _as_float(ys)
        for j in range(min(int(src_t.size), int(src_y.size))):
            value = float(src_y[j])
            if not np.isfinite(value):
                continue
            off = id_to_off.get(int(src_t[j]) // self.width)
            if off is None:
                continue
            if cnt[off] == 0:
                mn[off] = value
                mx[off] = value
            else:
                if value < mn[off]:
                    mn[off] = value
                if value > mx[off]:
                    mx[off] = value
            cnt[off] += 1
            acc[off] += value
        out_t: list[int] = []
        mean: list[float | None] = []
        lo: list[float | None] = []
        hi: list[float | None] = []
        for a, b in kept:
            out_t.append(self._group_t(a, b))
            total = 0
            s = 0.0
            low = None
            high = None
            for i in range(a, b):
                c = cnt[i - lo_i]
                if c <= 0:
                    continue
                total += c
                s += acc[i - lo_i]
                if low is None or mn[i - lo_i] < low:
                    low = mn[i - lo_i]
                if high is None or mx[i - lo_i] > high:
                    high = mx[i - lo_i]
            if total <= 0:
                mean.append(None)
                lo.append(None)
                hi.append(None)
            elif total == 1:
                mean.append(s)
                lo.append(s)
                hi.append(s)
            else:
                mean.append(s / total)
                lo.append(low)
                hi.append(high)
        return {"t": out_t, "mean": mean, "min": lo, "max": hi, "raw": False}

    def _fold(self, ch: int, a: int, b: int) -> tuple[int, float | None, float | None, float | None]:
        total = 0
        acc = 0.0
        lo = None
        hi = None
        first_t = self.t[a]
        last_t = self.last_t[b - 1]
        bid0 = self.bin_id[a]
        for i in range(a, b):
            n = self.counts[ch][i]
            if n <= 0:
                continue
            total += n
            acc += self.sums[ch][i]
            if lo is None or self.mins[ch][i] < lo:
                lo = self.mins[ch][i]
            if hi is None or self.maxs[ch][i] > hi:
                hi = self.maxs[ch][i]
        if total <= 0:
            return first_t, None, None, None
        mean = acc / total
        if total == 1:
            return first_t, mean, mean, mean
        if b == a + 1:
            return int(bid0 * self.width + self.width // 2), mean, lo, hi
        return (first_t + last_t) // 2, mean, lo, hi


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


def prefer_raw(sample_count: int, max_points: int = GRAPH_POINTS) -> bool:
    return int(sample_count) <= max(1, int(max_points))


def band_from_values(t: list[int], mean: list, lo: list, hi: list) -> dict[str, list]:
    return {"t": t, "mean": mean, "min": lo, "max": hi}
