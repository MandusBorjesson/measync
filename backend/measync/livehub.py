from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

log = logging.getLogger(__name__)


class LiveHub:
    def __init__(self) -> None:
        self._subs: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._loop: asyncio.AbstractEventLoop | None = None
        self.latest: dict[str, bytes | dict] = {}

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, source_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=2)
        self._subs[source_id].append(queue)
        latest = self.latest.get(source_id)
        if latest is not None:
            try:
                queue.put_nowait(latest)
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
        self.latest[source_id] = payload
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        try:
            loop.call_soon_threadsafe(self._fanout, source_id, payload)
        except RuntimeError:
            log.debug("live hub loop closed")

    def drop_source(self, source_id: str) -> None:
        self.latest.pop(source_id, None)
        self._subs.pop(source_id, None)

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
