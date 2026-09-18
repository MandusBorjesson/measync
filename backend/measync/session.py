from __future__ import annotations

from pathlib import Path

from measync.capture import CaptureHandle
from measync.livehub import LiveHub
from measync.models import SourceInfo
from measync.presence import PresenceHub
from measync.profiles import ProfileStore
from measync.ring import RingBuffer

DEFAULT_CAP = 1_000_000_000


class Session:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.ring = RingBuffer(DEFAULT_CAP)
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
                live=True,
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
            )
        return list(by_id.values())

    def add_source(self, source_id: str, kind: str, label: str, index: int) -> CaptureHandle:
        existing = self.sources.get(source_id)
        if existing:
            return existing
        handle = CaptureHandle(source_id, kind, label, index)
        self.sources[source_id] = handle
        handle.start(self)
        return handle

    def release_source(self, source_id: str) -> None:
        handle = self.sources.pop(source_id, None)
        if handle:
            handle.stop()
            self.hub.drop_source(source_id)

    def start_recording(self) -> None:
        if self.recording:
            return
        self.ring.clear()
        self.dirty = False
        self.recording = True

    def stop_recording(self) -> None:
        self.recording = False

    def shutdown(self) -> None:
        self.recording = False
        for source_id in list(self.sources):
            self.release_source(source_id)
