from __future__ import annotations

import asyncio
import itertools
import logging
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

PALETTE = ["#e8a838", "#3dcdc0", "#7aa2f7", "#c07af7", "#e24a7b", "#9ece6a", "#ff9e64", "#bb9af7"]


@dataclass
class Peer:
    id: str
    name: str
    color: str
    lock_front: bool = True
    lock_back: bool = True
    center: int | None = None
    duration: int | None = None
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=32))

    def public(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "lock_front": self.lock_front,
            "lock_back": self.lock_back,
            "center": self.center,
            "duration": self.duration,
        }


class PresenceHub:
    def __init__(self) -> None:
        self._peers: dict[str, Peer] = {}
        self._ids = itertools.count(1)
        self._colors = itertools.cycle(PALETTE)
        self._lock = asyncio.Lock()
        self.layout: dict = {"layout": None, "tiles": {}}

    async def join(self, name: str) -> Peer:
        async with self._lock:
            peer = Peer(
                id=f"user-{next(self._ids)}",
                name=name.strip() or "anon",
                color=next(self._colors),
            )
            self._peers[peer.id] = peer
        await self.broadcast({"type": "peers", "peers": self.list_public()})
        return peer

    async def leave(self, peer_id: str) -> None:
        async with self._lock:
            self._peers.pop(peer_id, None)
        await self.broadcast({"type": "peers", "peers": self.list_public()})

    async def update_viewport(
        self,
        peer_id: str,
        lock_front: bool,
        lock_back: bool,
        center: int | None,
        duration: int | None,
    ) -> None:
        async with self._lock:
            peer = self._peers.get(peer_id)
            if peer is None:
                return
            peer.lock_front = lock_front
            peer.lock_back = lock_back
            peer.center = int(center) if center is not None else None
            peer.duration = int(duration) if duration is not None else None
            snapshot = self.list_public()
        await self.broadcast({"type": "peers", "peers": snapshot})

    def list_public(self) -> list[dict]:
        return [p.public() for p in self._peers.values()]

    async def set_layout(self, payload: dict, origin: str | None) -> dict:
        self.layout = {
            "layout": payload.get("layout"),
            "tiles": payload.get("tiles") or {},
        }
        await self.broadcast({"type": "layout", "origin": origin, **self.layout}, exclude=origin)
        return self.layout

    async def broadcast(self, message: dict, exclude: str | None = None) -> None:
        for peer in list(self._peers.values()):
            if exclude and peer.id == exclude:
                continue
            if peer.queue.full():
                try:
                    peer.queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                peer.queue.put_nowait(message)
            except asyncio.QueueFull:
                pass
