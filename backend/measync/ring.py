from __future__ import annotations

import threading
from bisect import bisect_left
from dataclasses import dataclass, field

import numpy as np

JPEG_OVERHEAD = 24
PCM_OVERHEAD = 32


@dataclass
class CamTrack:
    label: str
    kind: str = "camera"
    t: list[int] = field(default_factory=list)
    jpeg: list[bytes] = field(default_factory=list)
    start: int = 0

    def __len__(self) -> int:
        return len(self.t) - self.start

    def append(self, t_ns: int, jpeg: bytes) -> int:
        self.t.append(t_ns)
        self.jpeg.append(jpeg)
        return len(jpeg) + JPEG_OVERHEAD

    def pop_while_at_or_before(self, horizon_ns: int) -> int:
        freed = 0
        while self.start < len(self.t) and self.t[self.start] <= horizon_ns:
            freed += len(self.jpeg[self.start]) + JPEG_OVERHEAD
            self.start += 1
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

    def series(self, t0: int, t1: int, zones: list | None = None, max_points: int = 2000) -> dict:
        from measync.thermal import peek_coarse, peek_stats, series_point

        rects = list(zones or ())
        empty_zones = [{"min": [], "max": []} for _ in rects]
        empty = {"t": [], "min": [], "max": [], "center": [], "zones": empty_zones}
        if self.start >= len(self.t):
            return empty
        i0 = bisect_left(self.t, t0, self.start)
        i1 = bisect_left(self.t, t1, self.start)
        i0 = max(i0, self.start)
        i1 = max(i1, i0)
        span = i1 - i0
        if span <= 0:
            return empty
        cap = 400 if rects else max_points
        if rects and peek_coarse(self.jpeg[i0]) is None:
            cap = 120
        step = max(1, span // cap)
        ts: list[int] = []
        mins: list[float] = []
        maxs: list[float] = []
        centers: list[float] = []
        zone_mins: list[list[float | None]] = [[] for _ in rects]
        zone_maxs: list[list[float | None]] = [[] for _ in rects]
        for i in range(i0, i1, step):
            j = min(i + step, i1)
            bucket_min: float | None = None
            bucket_max: float | None = None
            bucket_center: float | None = None
            sample_index: int | None = None
            for k in range(i, j):
                stats = peek_stats(self.jpeg[k])
                if stats is None:
                    continue
                lo, hi, mid = stats
                bucket_min = lo if bucket_min is None else min(bucket_min, lo)
                bucket_max = hi if bucket_max is None else max(bucket_max, hi)
                bucket_center = mid
                if sample_index is None:
                    sample_index = k
            if bucket_min is None or bucket_max is None or bucket_center is None:
                continue
            ts.append(self.t[i])
            mins.append(bucket_min)
            maxs.append(bucket_max)
            centers.append(bucket_center)
            zone_vals: list[tuple[float | None, float | None]] = [(None, None) for _ in rects]
            if rects and sample_index is not None:
                point = series_point(self.jpeg[sample_index], rects)
                if point is not None:
                    zone_vals = [(z["min"], z["max"]) for z in point["zones"]]
            for idx, (lo, hi) in enumerate(zone_vals):
                zone_mins[idx].append(lo)
                zone_maxs[idx].append(hi)
        return {
            "t": ts,
            "min": mins,
            "max": maxs,
            "center": centers,
            "zones": [{"min": zone_mins[i], "max": zone_maxs[i]} for i in range(len(zone_mins))],
        }


@dataclass
class AudioTrack:
    label: str
    sample_rate: int
    t: list[int] = field(default_factory=list)
    pcm: list[np.ndarray] = field(default_factory=list)
    pmin: list[float] = field(default_factory=list)
    pmax: list[float] = field(default_factory=list)
    start: int = 0

    def __len__(self) -> int:
        return len(self.t) - self.start

    def append(self, t_ns: int, samples: np.ndarray) -> int:
        chunk = np.ascontiguousarray(samples, dtype=np.float32)
        self.t.append(t_ns)
        self.pcm.append(chunk)
        self.pmin.append(float(chunk.min()) if chunk.size else 0.0)
        self.pmax.append(float(chunk.max()) if chunk.size else 0.0)
        return int(chunk.nbytes) + PCM_OVERHEAD

    def pop_while_at_or_before(self, horizon_ns: int) -> int:
        freed = 0
        while self.start < len(self.t) and self.t[self.start] <= horizon_ns:
            freed += int(self.pcm[self.start].nbytes) + PCM_OVERHEAD
            self.start += 1
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
        i1 = bisect_left(self.t, t1, self.start)
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

    def envelope(self, t0: int, t1: int, max_points: int = 2000) -> dict:
        if self.start >= len(self.t):
            return {"t": [], "min": [], "max": [], "sample_rate": self.sample_rate}
        i0 = bisect_left(self.t, t0, self.start)
        i1 = bisect_left(self.t, t1, self.start)
        i0 = max(i0, self.start)
        i1 = max(i1, i0)
        span = i1 - i0
        if span <= 0:
            return {"t": [], "min": [], "max": [], "sample_rate": self.sample_rate}
        step = max(1, span // max_points)
        ts: list[int] = []
        mins: list[float] = []
        maxs: list[float] = []
        for i in range(i0, i1, step):
            j = min(i + step, i1)
            ts.append(self.t[i])
            mins.append(min(self.pmin[i:j]))
            maxs.append(max(self.pmax[i:j]))
        return {"t": ts, "min": mins, "max": maxs, "sample_rate": self.sample_rate}


class RingBuffer:
    def __init__(self, cap_bytes: int = 1_000_000_000) -> None:
        self.cap_bytes = cap_bytes
        self.used = 0
        self.lock = threading.Lock()
        self.camera: dict[str, CamTrack] = {}
        self.audio: dict[str, AudioTrack] = {}

    def clear(self) -> None:
        with self.lock:
            self.camera.clear()
            self.audio.clear()
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

    def audio_envelope(self, source_id: str, t0: int, t1: int) -> dict | None:
        with self.lock:
            track = self.audio.get(source_id)
            if track is None:
                return None
            return track.envelope(t0, t1)

    def thermal_series(
        self,
        source_id: str,
        t0: int,
        t1: int,
        zones: list | None = None,
    ) -> dict | None:
        with self.lock:
            track = self.camera.get(source_id)
            if track is None or track.kind != "thermal":
                return None
            return track.series(t0, t1, zones)

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
            return out

    def replace_from(self, camera: dict[str, CamTrack], audio: dict[str, AudioTrack], used: int) -> None:
        with self.lock:
            self.camera = camera
            self.audio = audio
            self.used = used
            self._evict_unlocked()

    def copy_tracks(self) -> tuple[dict[str, CamTrack], dict[str, AudioTrack]]:
        with self.lock:
            cameras: dict[str, CamTrack] = {}
            for sid, track in self.camera.items():
                snap = CamTrack(label=track.label, kind=track.kind)
                snap.t = list(track.t[track.start :])
                snap.jpeg = list(track.jpeg[track.start :])
                cameras[sid] = snap
            audios: dict[str, AudioTrack] = {}
            for sid, track in self.audio.items():
                snap = AudioTrack(label=track.label, sample_rate=track.sample_rate)
                snap.t = list(track.t[track.start :])
                snap.pcm = list(track.pcm[track.start :])
                snap.pmin = list(track.pmin[track.start :])
                snap.pmax = list(track.pmax[track.start :])
                audios[sid] = snap
            return cameras, audios

    def _range_unlocked(self) -> tuple[int | None, int | None]:
        t_min: int | None = None
        t_max: int | None = None
        for track in (*self.camera.values(), *self.audio.values()):
            first = track.first_t()
            last = track.last_t()
            if first is None or last is None:
                continue
            t_min = first if t_min is None else min(t_min, first)
            t_max = last if t_max is None else max(t_max, last)
        return t_min, t_max

    def _evict_unlocked(self) -> None:
        while self.used > self.cap_bytes:
            oldest: int | None = None
            for track in (*self.camera.values(), *self.audio.values()):
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
            if freed <= 0:
                break
            self.used = max(0, self.used - freed)
