from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

log = logging.getLogger(__name__)

OFFLINE = {"type": "offline"}


class LiveHub:
    def __init__(self) -> None:
        self._subs: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._known: set[str] = set()
        self.latest: dict[str, bytes | dict] = {}

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, source_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=2)
        self._subs[source_id].append(queue)
        latest = self.latest.get(source_id)
        snapshot: bytes | dict | None = latest
        if snapshot is None and source_id in self._known:
            snapshot = OFFLINE
        if snapshot is not None:
            try:
                queue.put_nowait(snapshot)
            except asyncio.QueueFull:
                pass
        return queue

    def unsubscribe(self, source_id: str, queue: asyncio.Queue) -> None:
        subs = self._subs.get(source_id)
        if not subs:
            return
        try:
            subs.remove(queue)
        except ValueError:
            pass

    def publish(self, source_id: str, payload: bytes | dict) -> None:
        self._known.add(source_id)
        if isinstance(payload, dict) and payload.get("type") == "offline":
            self.latest.pop(source_id, None)
        else:
            self.latest[source_id] = payload
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        try:
            loop.call_soon_threadsafe(self._fanout, source_id, payload)
        except RuntimeError:
            log.debug("live hub loop closed")

    def publish_offline(self, source_id: str) -> None:
        self.publish(source_id, OFFLINE)

    def drop_source(self, source_id: str) -> None:
        self.latest.pop(source_id, None)
        self._subs.pop(source_id, None)
        self._known.discard(source_id)

    def _fanout(self, source_id: str, payload: bytes | dict) -> None:
        for queue in list(self._subs.get(source_id, ())):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass
