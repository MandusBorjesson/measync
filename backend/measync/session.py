from __future__ import annotations

from pathlib import Path

import numpy as np

from measync.capture import CaptureHandle
from measync.livehub import LiveHub
from measync.models import SourceInfo
from measync.presence import PresenceHub
from measync.profiles import ProfileStore
from measync.ring import RingBuffer

DEFAULT_CAP = 1_000_000_000
LIVE_KEEP_NS = 5_000_000_000


class Session:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.ring = RingBuffer(DEFAULT_CAP)
        self.live_ring = RingBuffer(DEFAULT_CAP, keep_ns=LIVE_KEEP_NS)
        self.hub = LiveHub()
        self.presence = PresenceHub()
        self.profiles = ProfileStore(data_dir / "profiles")
        self.captures_dir = data_dir / "captures"
        self.captures_dir.mkdir(parents=True, exist_ok=True)
        self.recording = False
        self.dirty = False
        self.sources: dict[str, CaptureHandle] = {}

    def source_infos(self) -> list[SourceInfo]:
        by_id: dict[str, SourceInfo] = {}
        for handle in self.sources.values():
            by_id[handle.source_id] = SourceInfo(
                id=handle.source_id,
                kind=handle.kind,  # type: ignore[arg-type]
                label=handle.label,
                sample_rate=handle.sample_rate,
                sample_rates=handle.sample_rates or None,
                output_on=handle.output_on,
                live=True,
                online=handle.online,
            )
        for meta in self.ring.track_meta():
            if meta["id"] in by_id:
                continue
            by_id[meta["id"]] = SourceInfo(
                id=meta["id"],
                kind=meta["kind"],
                label=meta["label"],
                sample_rate=meta.get("sample_rate"),
                live=False,
                online=False,
            )
        return list(by_id.values())

    def capture_empty(self) -> bool:
        return self.ring.range_ns()[0] is None

    def previewing(self) -> bool:
        return not self.recording and self.capture_empty()

    def add_source(self, source_id: str, kind: str, label: str, index: int) -> CaptureHandle:
        existing = self.sources.get(source_id)
        if existing:
            return existing
        handle = CaptureHandle(source_id, kind, label, index)
        self.sources[source_id] = handle
        handle.start(self)
        return handle

    def set_source_rate(self, source_id: str, sample_rate: int) -> CaptureHandle:
        handle = self.sources.get(source_id)
        if handle is None:
            raise KeyError(source_id)
        handle.set_sample_rate(sample_rate)
        return handle

    def set_source_output(self, source_id: str, output_on: bool) -> CaptureHandle:
        handle = self.sources.get(source_id)
        if handle is None:
            raise KeyError(source_id)
        handle.set_output(output_on)
        return handle

    def release_source(self, source_id: str) -> None:
        handle = self.sources.pop(source_id, None)
        if handle:
            handle.stop()
            self.hub.drop_source(source_id)

    def start_recording(self) -> None:
        if self.recording:
            return
        if self.capture_empty():
            cameras, audio, scopes, used = self.live_ring.copy_tracks()
            self.ring.replace_from(cameras, audio, used, scopes)
            if not self.capture_empty():
                self.dirty = True
        self.recording = True

    def stop_recording(self) -> None:
        self.recording = False

    def reset(self) -> None:
        self.recording = False
        self.ring.clear()
        self.live_ring.clear()
        self.dirty = False

    def query_ring(self, t0: int, t1: int | None = None) -> RingBuffer:
        del t0, t1
        # Window times select samples inside a ring; they must not switch which
        # ring is queried. A frozen take always reads from the capture ring.
        if not self.capture_empty():
            return self.ring
        return self.live_ring

    def store_camera(
        self, source_id: str, label: str, t_ns: int, jpeg: bytes, kind: str | None = None
    ) -> None:
        if self.recording:
            self.ring.append_camera(source_id, label, t_ns, jpeg, kind=kind)
            self.dirty = True
        elif self.previewing():
            self.live_ring.append_camera(source_id, label, t_ns, jpeg, kind=kind)

    def store_audio(
        self, source_id: str, label: str, sample_rate: int, t_ns: int, samples: np.ndarray
    ) -> None:
        if self.recording:
            self.ring.append_audio(source_id, label, sample_rate, t_ns, samples)
            self.dirty = True
        elif self.previewing():
            self.live_ring.append_audio(source_id, label, sample_rate, t_ns, samples)

    def store_joulescope(
        self,
        source_id: str,
        label: str,
        sample_rate: int,
        t_ns: int,
        current: np.ndarray,
        voltage: np.ndarray,
        power: np.ndarray,
    ) -> None:
        if self.recording:
            self.ring.append_joulescope(source_id, label, sample_rate, t_ns, current, voltage, power)
            self.dirty = True
        elif self.previewing():
            self.live_ring.append_joulescope(
                source_id, label, sample_rate, t_ns, current, voltage, power
            )

    def shutdown(self) -> None:
        self.recording = False
        for source_id in list(self.sources):
            self.release_source(source_id)
