from __future__ import annotations

import threading
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field

import numpy as np

from measync.graph import GRAPH_POINTS, IngestBins, align_window, prefer_raw, raw_band

JPEG_OVERHEAD = 24
PCM_OVERHEAD = 32
GRAPH_OVERHEAD = 48


def _chunks_overlapping(t: list[int], start: int, t0: int, t1: int) -> tuple[int, int]:
    """Return [i0, i1) of chunks whose last-sample stamp may overlap [t0, t1].

    Chunk timestamps are the last sample in the batch. Samples in that chunk
    extend backward, so the window needs the chunk before t0 and the one after t1.
    """
    if start >= len(t):
        return start, start
    i0 = bisect_left(t, t0, start)
    if i0 > start:
        i0 -= 1
    i1 = bisect_right(t, t1, start)
    if i1 < len(t):
        i1 += 1
    i0 = max(i0, start)
    return i0, max(i1, i0)


def _chunk_dt_ns(sample_rate: int) -> int:
    return max(1, int(round(1_000_000_000 / max(1, sample_rate))))


def _own_f32(values: np.ndarray) -> np.ndarray:
    """Owned C-contiguous float32. Device callbacks reuse their buffers."""
    return np.array(values, dtype=np.float32, copy=True, order="C")


def _monotonic_chunk_end(prev_end: int | None, t_ns: int, n: int, sample_rate: int) -> int:
    """Keep reconstructed sample windows from overlapping a previous chunk.

    Chunk stamps are the last sample. Samples extend backward n×dt, so a stamp
    that is not at least n samples after the previous end would rewrite history.
    """
    if prev_end is None or n <= 0:
        return t_ns
    min_end = int(prev_end) + max(1, n) * _chunk_dt_ns(sample_rate)
    return t_ns if t_ns >= min_end else min_end


def _sample_times(t_end: int, n: int, sample_rate: int) -> np.ndarray:
    """Place n samples at 1/sample_rate, with the last sample at t_end.

    USB callbacks deliver uneven batches. Do not stretch samples across the
    wall-clock gap between chunks — that looks like the rate jumping.
    """
    if n <= 0:
        return np.zeros(0, dtype=np.int64)
    if n == 1:
        return np.array([t_end], dtype=np.int64)
    dt = _chunk_dt_ns(sample_rate)
    return t_end + (np.arange(n, dtype=np.int64) - (n - 1)) * dt


def _in_window_count(t_end: int, n: int, sample_rate: int, t0: int, t1: int) -> int:
    if n <= 0:
        return 0
    dt = max(1, int(round(1_000_000_000 / max(1, sample_rate))))
    first = t_end - (n - 1) * dt
    lo = max(first, t0)
    hi = min(t_end, t1)
    if hi < lo:
        return 0
    return int((hi - lo) // dt) + 1


def _empty_band() -> dict[str, list]:
    return {"mean": [], "min": [], "max": []}


def _drop_t(band: dict) -> dict[str, list]:
    return {"mean": band["mean"], "min": band["min"], "max": band["max"]}


@dataclass
class CamTrack:
    label: str
    kind: str = "camera"
    t: list[int] = field(default_factory=list)
    jpeg: list[bytes] = field(default_factory=list)
    bins: IngestBins = field(default_factory=lambda: IngestBins(3))
    start: int = 0

    def __len__(self) -> int:
        return len(self.t) - self.start

    def append(self, t_ns: int, jpeg: bytes) -> int:
        self.t.append(t_ns)
        self.jpeg.append(jpeg)
        if self.kind == "thermal":
            from measync.thermal import peek_stats

            stats = peek_stats(jpeg)
            if stats is not None:
                lo, hi, mid = stats
                self.bins.add(
                    np.array([t_ns], dtype=np.int64),
                    np.array([lo], dtype=np.float64),
                    np.array([hi], dtype=np.float64),
                    np.array([mid], dtype=np.float64),
                )
        return len(jpeg) + JPEG_OVERHEAD

    def pop_while_at_or_before(self, horizon_ns: int) -> int:
        freed = 0
        while self.start < len(self.t) and self.t[self.start] <= horizon_ns:
            freed += len(self.jpeg[self.start]) + JPEG_OVERHEAD
            self.start += 1
        self.bins.pop_while_at_or_before(horizon_ns)
        self._compact()
        return freed

    def _compact(self) -> None:
        if self.start > 1024 and self.start * 2 >= len(self.t):
            self.t = self.t[self.start :]
            self.jpeg = self.jpeg[self.start :]
            self.start = 0

    def first_t(self) -> int | None:
        return self.t[self.start] if self.start < len(self.t) else None

    def last_t(self) -> int | None:
        return self.t[-1] if self.start < len(self.t) else None

    def nearest(self, t_ns: int) -> bytes | None:
        if self.start >= len(self.t):
            return None
        i = bisect_left(self.t, t_ns, self.start)
        if i <= self.start:
            return self.jpeg[self.start]
        if i >= len(self.t):
            return self.jpeg[-1]
        before = i - 1
        if abs(self.t[before] - t_ns) <= abs(self.t[i] - t_ns):
            return self.jpeg[before]
        return self.jpeg[i]

    def series(self, t0: int, t1: int, zones: list | None = None, max_points: int = GRAPH_POINTS) -> dict:
        rects = list(zones or ())
        empty_zones = [{"min": _empty_band(), "max": _empty_band()} for _ in rects]
        empty = {
            "t": [],
            "min": _empty_band(),
            "max": _empty_band(),
            "center": _empty_band(),
            "zones": empty_zones,
            "raw": False,
        }
        if self.start >= len(self.t):
            return empty
        i0 = bisect_left(self.t, t0, self.start)
        i1 = bisect_right(self.t, t1, self.start)
        i0 = max(i0, self.start)
        i1 = max(i1, i0)
        if i1 <= i0:
            return empty
        if prefer_raw(i1 - i0, max_points):
            return self._raw_series(i0, i1, t0, t1, rects, empty)
        gmin, gmax, gcenter = self.bins.emit(t0, t1, max_points)
        if not gmin["t"]:
            return empty
        return {
            "t": gmin["t"],
            "min": _drop_t(gmin),
            "max": _drop_t(gmax),
            "center": _drop_t(gcenter),
            "zones": self._zone_bands(i0, i1, t0, t1, rects, max_points) if rects else empty_zones,
            "raw": False,
        }

    def _raw_series(self, i0: int, i1: int, t0: int, t1: int, rects: list, empty: dict) -> dict:
        from measync.thermal import peek_stats, series_point

        ts: list[int] = []
        mins: list[float] = []
        maxs: list[float] = []
        centers: list[float] = []
        zone_mins: list[list[float | None]] = [[] for _ in rects]
        zone_maxs: list[list[float | None]] = [[] for _ in rects]
        for k in range(i0, i1):
            stats = peek_stats(self.jpeg[k])
            if stats is None:
                continue
            lo, hi, mid = stats
            ts.append(self.t[k])
            mins.append(lo)
            maxs.append(hi)
            centers.append(mid)
            if rects:
                point = series_point(self.jpeg[k], rects)
                zvals = point["zones"] if point is not None else [{"min": None, "max": None} for _ in rects]
                for idx, z in enumerate(zvals):
                    zone_mins[idx].append(z.get("min"))
                    zone_maxs[idx].append(z.get("max"))
        if not ts:
            return empty
        ts_arr = np.asarray(ts, dtype=np.int64)
        gmin = raw_band(ts_arr, np.asarray(mins, dtype=np.float64))
        return {
            "t": gmin["t"],
            "min": _drop_t(gmin),
            "max": _drop_t(raw_band(ts_arr, np.asarray(maxs, dtype=np.float64))),
            "center": _drop_t(raw_band(ts_arr, np.asarray(centers, dtype=np.float64))),
            "zones": [
                {
                    "min": _drop_t(raw_band(ts_arr, zone_mins[idx])),
                    "max": _drop_t(raw_band(ts_arr, zone_maxs[idx])),
                }
                for idx in range(len(rects))
            ],
            "raw": True,
        }

    def _zone_bands(self, i0: int, i1: int, t0: int, t1: int, rects: list, max_points: int) -> list[dict]:
        from measync.thermal import peek_coarse, series_point

        inspect = 1
        if peek_coarse(self.jpeg[i0]) is None:
            inspect = max(1, (i1 - i0) // 120)
        ts: list[int] = []
        zone_mins: list[list[float | None]] = [[] for _ in rects]
        zone_maxs: list[list[float | None]] = [[] for _ in rects]
        for k in range(i0, i1, inspect):
            point = series_point(self.jpeg[k], rects)
            if point is None:
                continue
            ts.append(self.t[k])
            zvals = point["zones"]
            for idx, z in enumerate(zvals):
                zone_mins[idx].append(z.get("min"))
                zone_maxs[idx].append(z.get("max"))
        if not ts:
            return [{"min": _empty_band(), "max": _empty_band()} for _ in rects]
        ts_arr = np.asarray(ts, dtype=np.int64)
        return [
            {
                "min": _drop_t(self.bins.project(ts_arr, zone_mins[idx], t0, t1, max_points)),
                "max": _drop_t(self.bins.project(ts_arr, zone_maxs[idx], t0, t1, max_points)),
            }
            for idx in range(len(rects))
        ]


@dataclass
class AudioTrack:
    label: str
    sample_rate: int
    t: list[int] = field(default_factory=list)
    pcm: list[np.ndarray] = field(default_factory=list)
    pmin: list[float] = field(default_factory=list)
    pmax: list[float] = field(default_factory=list)
    bins: IngestBins = field(default_factory=IngestBins)
    start: int = 0

    def __len__(self) -> int:
        return len(self.t) - self.start

    def append(self, t_ns: int, samples: np.ndarray) -> int:
        chunk = _own_f32(samples)
        self.t.append(t_ns)
        self.pcm.append(chunk)
        self.pmin.append(float(chunk.min()) if chunk.size else 0.0)
        self.pmax.append(float(chunk.max()) if chunk.size else 0.0)
        self.bins.add(_sample_times(t_ns, int(chunk.size), self.sample_rate), chunk)
        return int(chunk.nbytes) + PCM_OVERHEAD

    def pop_while_at_or_before(self, horizon_ns: int) -> int:
        freed = 0
        while self.start < len(self.t) and self.t[self.start] <= horizon_ns:
            freed += int(self.pcm[self.start].nbytes) + PCM_OVERHEAD
            self.start += 1
        self.bins.pop_while_at_or_before(horizon_ns)
        self._compact()
        return freed

    def _compact(self) -> None:
        if self.start > 1024 and self.start * 2 >= len(self.t):
            self.t = self.t[self.start :]
            self.pcm = self.pcm[self.start :]
            self.pmin = self.pmin[self.start :]
            self.pmax = self.pmax[self.start :]
            self.start = 0

    def first_t(self) -> int | None:
        return self.t[self.start] if self.start < len(self.t) else None

    def last_t(self) -> int | None:
        return self.t[-1] if self.start < len(self.t) else None

    def pcm_range(self, t0: int, t1: int) -> tuple[int, np.ndarray]:
        if self.start >= len(self.t):
            return self.sample_rate, np.zeros(0, dtype=np.float32)
        i0 = bisect_left(self.t, t0, self.start)
        i1 = bisect_right(self.t, t1, self.start)
        if i0 > self.start:
            i0 -= 1
        i0 = max(i0, self.start)
        i1 = max(i1, i0)
        if i1 <= i0:
            return self.sample_rate, np.zeros(0, dtype=np.float32)
        chunks = self.pcm[i0:i1]
        if not chunks:
            return self.sample_rate, np.zeros(0, dtype=np.float32)
        return self.sample_rate, np.ascontiguousarray(np.concatenate(chunks), dtype=np.float32)

    def envelope(self, t0: int, t1: int, max_points: int = GRAPH_POINTS) -> dict:
        empty = {"t": [], "mean": [], "min": [], "max": [], "sample_rate": self.sample_rate, "raw": False}
        if self.start >= len(self.t):
            return empty
        i0, i1 = _chunks_overlapping(self.t, self.start, t0, t1)
        if i1 <= i0:
            return empty
        count = 0
        for i in range(i0, i1):
            count += _in_window_count(self.t[i], int(self.pcm[i].size), self.sample_rate, t0, t1)
            if count > max_points:
                break
        if prefer_raw(count, max_points):
            ts_parts: list[np.ndarray] = []
            ys_parts: list[np.ndarray] = []
            for i in range(i0, i1):
                chunk = self.pcm[i]
                if chunk.size == 0:
                    continue
                ts_parts.append(_sample_times(self.t[i], int(chunk.size), self.sample_rate))
                ys_parts.append(chunk)
            if not ts_parts:
                return empty
            ts, channels = align_window(np.concatenate(ts_parts), [np.concatenate(ys_parts)], t0, t1)
            if ts.size == 0:
                return empty
            band = raw_band(ts, channels[0])
            band["sample_rate"] = self.sample_rate
            return band
        band = self.bins.emit(t0, t1, max_points)[0]
        band["sample_rate"] = self.sample_rate
        return band


@dataclass
class JoulescopeTrack:
    label: str
    sample_rate: int
    t: list[int] = field(default_factory=list)
    rates: list[int] = field(default_factory=list)
    current: list[np.ndarray] = field(default_factory=list)
    voltage: list[np.ndarray] = field(default_factory=list)
    power: list[np.ndarray] = field(default_factory=list)
    bins: IngestBins = field(default_factory=lambda: IngestBins(3))
    start: int = 0

    def __len__(self) -> int:
        return len(self.t) - self.start

    def append(
        self, t_ns: int, current: np.ndarray, voltage: np.ndarray, power: np.ndarray, sample_rate: int
    ) -> int:
        n = min(np.asarray(current).size, np.asarray(voltage).size, np.asarray(power).size)
        if n <= 0:
            return 0
        i = _own_f32(np.asarray(current)[:n])
        v = _own_f32(np.asarray(voltage)[:n])
        p = _own_f32(np.asarray(power)[:n])
        prev = self.t[-1] if self.start < len(self.t) else None
        t_ns = _monotonic_chunk_end(prev, t_ns, n, int(sample_rate))
        self.t.append(t_ns)
        self.rates.append(int(sample_rate))
        self.current.append(i)
        self.voltage.append(v)
        self.power.append(p)
        self.sample_rate = int(sample_rate)
        self.bins.add(_sample_times(t_ns, n, int(sample_rate)), i, v, p)
        return int(i.nbytes + v.nbytes + p.nbytes) + GRAPH_OVERHEAD

    def pop_while_at_or_before(self, horizon_ns: int) -> int:
        freed = 0
        while self.start < len(self.t) and self.t[self.start] <= horizon_ns:
            n = int(self.current[self.start].nbytes + self.voltage[self.start].nbytes + self.power[self.start].nbytes)
            freed += n + GRAPH_OVERHEAD
            self.start += 1
        self.bins.pop_while_at_or_before(horizon_ns)
        self._compact()
        return freed

    def _compact(self) -> None:
        if self.start > 1024 and self.start * 2 >= len(self.t):
            self.t = self.t[self.start :]
            self.rates = self.rates[self.start :]
            self.current = self.current[self.start :]
            self.voltage = self.voltage[self.start :]
            self.power = self.power[self.start :]
            self.start = 0

    def first_t(self) -> int | None:
        return self.t[self.start] if self.start < len(self.t) else None

    def last_t(self) -> int | None:
        return self.t[-1] if self.start < len(self.t) else None

    def series(self, t0: int, t1: int, max_points: int = GRAPH_POINTS) -> dict:
        empty = {
            "t": [],
            "current": _empty_band(),
            "voltage": _empty_band(),
            "power": _empty_band(),
            "sample_rate": self.sample_rate,
            "raw": False,
        }
        if self.start >= len(self.t):
            return empty
        i0, i1 = _chunks_overlapping(self.t, self.start, t0, t1)
        if i1 <= i0:
            return empty
        count = 0
        for k in range(i0, i1):
            count += _in_window_count(self.t[k], int(self.current[k].size), self.rates[k], t0, t1)
            if count > max_points:
                break
        if prefer_raw(count, max_points):
            return self._raw_series(i0, i1, t0, t1, empty)
        current, voltage, power = self.bins.emit(t0, t1, max_points)
        return {
            "t": current["t"],
            "current": _drop_t(current),
            "voltage": _drop_t(voltage),
            "power": _drop_t(power),
            "sample_rate": self.sample_rate,
            "raw": False,
        }

    def _raw_series(self, i0: int, i1: int, t0: int, t1: int, empty: dict) -> dict:
        ts_parts: list[np.ndarray] = []
        i_parts: list[np.ndarray] = []
        v_parts: list[np.ndarray] = []
        p_parts: list[np.ndarray] = []
        for k in range(i0, i1):
            chunk = self.current[k]
            n = int(chunk.size)
            if n <= 0:
                continue
            ts_parts.append(_sample_times(self.t[k], n, self.rates[k]))
            i_parts.append(chunk)
            v_parts.append(self.voltage[k])
            p_parts.append(self.power[k])
        if not ts_parts:
            return empty
        ts, (current, voltage, power) = align_window(
            np.concatenate(ts_parts),
            [np.concatenate(i_parts), np.concatenate(v_parts), np.concatenate(p_parts)],
            t0,
            t1,
        )
        if ts.size == 0:
            return empty
        i_band = raw_band(ts, current)
        return {
            "t": i_band["t"],
            "current": _drop_t(i_band),
            "voltage": _drop_t(raw_band(ts, voltage)),
            "power": _drop_t(raw_band(ts, power)),
            "sample_rate": self.sample_rate,
            "raw": True,
        }


class RingBuffer:
    def __init__(self, cap_bytes: int = 1_000_000_000, keep_ns: int | None = None) -> None:
        self.cap_bytes = cap_bytes
        self.keep_ns = keep_ns
        self.used = 0
        self.lock = threading.Lock()
        self.camera: dict[str, CamTrack] = {}
        self.audio: dict[str, AudioTrack] = {}
        self.joulescope: dict[str, JoulescopeTrack] = {}

    def _all_tracks(self):
        return (*self.camera.values(), *self.audio.values(), *self.joulescope.values())

    def clear(self) -> None:
        with self.lock:
            self.camera.clear()
            self.audio.clear()
            self.joulescope.clear()
            self.used = 0

    def set_cap(self, cap_bytes: int) -> None:
        with self.lock:
            self.cap_bytes = cap_bytes
            self._evict_unlocked()

    def append_camera(
        self, source_id: str, label: str, t_ns: int, jpeg: bytes, kind: str | None = None
    ) -> None:
        with self.lock:
            track = self.camera.get(source_id)
            if track is None:
                track = CamTrack(label=label, kind=kind or source_id.partition(":")[0] or "camera")
                self.camera[source_id] = track
            self.used += track.append(t_ns, jpeg)
            self._evict_unlocked()

    def append_audio(
        self, source_id: str, label: str, sample_rate: int, t_ns: int, samples: np.ndarray
    ) -> None:
        with self.lock:
            track = self.audio.get(source_id)
            if track is None:
                track = AudioTrack(label=label, sample_rate=sample_rate)
                self.audio[source_id] = track
            self.used += track.append(t_ns, samples)
            self._evict_unlocked()

    def append_joulescope(
        self,
        source_id: str,
        label: str,
        sample_rate: int,
        t_ns: int,
        current: np.ndarray,
        voltage: np.ndarray,
        power: np.ndarray,
    ) -> None:
        with self.lock:
            track = self.joulescope.get(source_id)
            if track is None:
                track = JoulescopeTrack(label=label, sample_rate=sample_rate)
                self.joulescope[source_id] = track
            self.used += track.append(t_ns, current, voltage, power, sample_rate)
            self._evict_unlocked()

    def range_ns(self) -> tuple[int | None, int | None]:
        with self.lock:
            return self._range_unlocked()

    def snapshot_status(self) -> tuple[int | None, int | None, int, int]:
        with self.lock:
            t_min, t_max = self._range_unlocked()
            return t_min, t_max, self.used, self.cap_bytes

    def camera_frame(self, source_id: str, t_ns: int) -> bytes | None:
        with self.lock:
            track = self.camera.get(source_id)
            if track is None:
                return None
            return track.nearest(t_ns)

    def audio_pcm(self, source_id: str, t0: int, t1: int) -> tuple[int, np.ndarray] | None:
        with self.lock:
            track = self.audio.get(source_id)
            if track is None:
                return None
            return track.pcm_range(t0, t1)

    def audio_envelope(self, source_id: str, t0: int, t1: int, max_points: int = GRAPH_POINTS) -> dict | None:
        with self.lock:
            track = self.audio.get(source_id)
            if track is None:
                return None
            return track.envelope(t0, t1, max_points)

    def thermal_series(
        self,
        source_id: str,
        t0: int,
        t1: int,
        zones: list | None = None,
        max_points: int = GRAPH_POINTS,
    ) -> dict | None:
        with self.lock:
            track = self.camera.get(source_id)
            if track is None or track.kind != "thermal":
                return None
            return track.series(t0, t1, zones, max_points)

    def joulescope_series(
        self, source_id: str, t0: int, t1: int, max_points: int = GRAPH_POINTS
    ) -> dict | None:
        with self.lock:
            track = self.joulescope.get(source_id)
            if track is None:
                return None
            return track.series(t0, t1, max_points)

    def track_meta(self) -> list[dict]:
        with self.lock:
            out: list[dict] = []
            for sid, track in self.camera.items():
                if len(track):
                    out.append({"id": sid, "kind": track.kind, "label": track.label, "live": False})
            for sid, track in self.audio.items():
                if len(track):
                    out.append(
                        {
                            "id": sid,
                            "kind": "audio",
                            "label": track.label,
                            "sample_rate": track.sample_rate,
                            "live": False,
                        }
                    )
            for sid, track in self.joulescope.items():
                if len(track):
                    out.append(
                        {
                            "id": sid,
                            "kind": "joulescope",
                            "label": track.label,
                            "sample_rate": track.sample_rate,
                            "live": False,
                        }
                    )
            return out

    def replace_from(
        self,
        camera: dict[str, CamTrack],
        audio: dict[str, AudioTrack],
        used: int,
        joulescope: dict[str, JoulescopeTrack] | None = None,
    ) -> None:
        with self.lock:
            self.camera = camera
            self.audio = audio
            self.joulescope = joulescope or {}
            self.used = used
            self._evict_unlocked()

    def copy_tracks(
        self,
    ) -> tuple[dict[str, CamTrack], dict[str, AudioTrack], dict[str, JoulescopeTrack], int]:
        with self.lock:
            cameras: dict[str, CamTrack] = {}
            for sid, track in self.camera.items():
                snap = CamTrack(label=track.label, kind=track.kind)
                snap.t = list(track.t[track.start :])
                snap.jpeg = list(track.jpeg[track.start :])
                snap.bins = track.bins.copy()
                cameras[sid] = snap
            audios: dict[str, AudioTrack] = {}
            for sid, track in self.audio.items():
                snap = AudioTrack(label=track.label, sample_rate=track.sample_rate)
                snap.t = list(track.t[track.start :])
                snap.pcm = list(track.pcm[track.start :])
                snap.pmin = list(track.pmin[track.start :])
                snap.pmax = list(track.pmax[track.start :])
                snap.bins = track.bins.copy()
                audios[sid] = snap
            scopes: dict[str, JoulescopeTrack] = {}
            for sid, track in self.joulescope.items():
                snap = JoulescopeTrack(label=track.label, sample_rate=track.sample_rate)
                snap.t = list(track.t[track.start :])
                snap.rates = list(track.rates[track.start :])
                snap.current = list(track.current[track.start :])
                snap.voltage = list(track.voltage[track.start :])
                snap.power = list(track.power[track.start :])
                snap.bins = track.bins.copy()
                scopes[sid] = snap
            return cameras, audios, scopes, self.used

    def _range_unlocked(self) -> tuple[int | None, int | None]:
        t_min: int | None = None
        t_max: int | None = None
        for track in self._all_tracks():
            first = track.first_t()
            last = track.last_t()
            if first is None or last is None:
                continue
            t_min = first if t_min is None else min(t_min, first)
            t_max = last if t_max is None else max(t_max, last)
        return t_min, t_max

    def _trim_to_unlocked(self, keep_ns: int) -> None:
        t_min, t_max = self._range_unlocked()
        if t_min is None or t_max is None:
            return
        horizon = t_max - keep_ns
        if horizon <= t_min:
            return
        freed = 0
        for track in self._all_tracks():
            freed += track.pop_while_at_or_before(horizon)
        self.used = max(0, self.used - freed)

    def _evict_unlocked(self) -> None:
        if self.keep_ns is not None:
            self._trim_to_unlocked(self.keep_ns)
        while self.used > self.cap_bytes:
            oldest: int | None = None
            for track in self._all_tracks():
                first = track.first_t()
                if first is None:
                    continue
                oldest = first if oldest is None else min(oldest, first)
            if oldest is None:
                self.used = 0
                break
            freed = 0
            for track in self.camera.values():
                freed += track.pop_while_at_or_before(oldest)
            for track in self.audio.values():
                freed += track.pop_while_at_or_before(oldest)
            for track in self.joulescope.values():
                freed += track.pop_while_at_or_before(oldest)
            if freed <= 0:
                break
            self.used = max(0, self.used - freed)
