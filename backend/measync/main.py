from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from measync import devices as device_mod
from measync import persist
from measync.models import CaptureName, CapUpdate, ProfilePayload
from measync.session import Session

log = logging.getLogger("measync")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
STATE: Session | None = None


def session() -> Session:
    if STATE is None:
        raise RuntimeError("session not initialized")
    return STATE


@asynccontextmanager
async def lifespan(app: FastAPI):
    global STATE
    STATE = Session(DATA_DIR)
    STATE.hub.bind_loop(asyncio.get_running_loop())
    log.info("measync data dir %s", DATA_DIR)
    try:
        yield
    finally:
        STATE.shutdown()
        STATE = None


app = FastAPI(title="measync", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/devices")
def list_devices() -> dict:
    busy = {h.index for h in session().sources.values() if h.kind in {"camera", "thermal"}}
    return {"devices": [d.model_dump() for d in device_mod.list_devices(busy_cameras=busy)]}


@app.get("/api/session")
def get_session() -> dict:
    s = session()
    t_min, t_max, used, cap = s.ring.snapshot_status()
    return {
        "recording": s.recording,
        "t_min": t_min,
        "t_max": t_max,
        "bytes_used": used,
        "bytes_cap": cap,
        "dirty": s.dirty,
        "sources": [src.model_dump() for src in s.source_infos()],
    }


@app.put("/api/session/cap")
def set_cap(body: CapUpdate) -> dict:
    session().ring.set_cap(body.bytes_cap)
    return get_session()


@app.post("/api/session/start")
def start_recording() -> dict:
    session().start_recording()
    return get_session()


@app.post("/api/session/stop")
def stop_recording() -> dict:
    session().stop_recording()
    return get_session()


def _resolve_device(source_id: str):
    kind, _, raw_index = source_id.partition(":")
    if kind not in {"camera", "audio", "thermal"} or not raw_index.isdigit():
        raise HTTPException(400, "source id must be camera:<n>, audio:<n>, or thermal:<n>")
    index = int(raw_index)
    if kind == "camera":
        from pathlib import Path

        from measync.devices import _camera_label

        if not Path(f"/dev/video{index}").exists():
            raise HTTPException(404, f"device {source_id} not found")
        from measync.thermal import is_thermal_usb

        if is_thermal_usb(index):
            raise HTTPException(400, f"device {source_id} is a thermal camera; use thermal:{index}")
        return kind, index, _camera_label(index)
    if kind == "thermal":
        from pathlib import Path

        from measync.thermal import is_thermal_capture, thermal_label

        if not Path(f"/dev/video{index}").exists() or not is_thermal_capture(index):
            raise HTTPException(404, f"device {source_id} not found")
        return kind, index, thermal_label(index)
    match = next((d for d in device_mod.list_mics() if d.id == source_id), None)
    if match is None:
        raise HTTPException(404, f"device {source_id} not found")
    return kind, index, match.label


@app.post("/api/sources/{source_id:path}")
def add_source(source_id: str) -> dict:
    s = session()
    kind, index, label = _resolve_device(source_id)
    handle = s.add_source(source_id, kind, label, index)
    return {"id": handle.source_id, "kind": handle.kind, "label": handle.label}


@app.delete("/api/sources/{source_id:path}")
def drop_source(source_id: str) -> dict:
    session().release_source(source_id)
    return {"ok": True}


@app.get("/api/session/camera/{source_id:path}/frame")
def camera_frame(source_id: str, t: float) -> Response:
    jpeg = session().ring.camera_frame(source_id, int(round(t)))
    if jpeg is None:
        raise HTTPException(404, "no frame")
    return Response(content=jpeg, media_type="image/jpeg")


@app.get("/api/session/thermal/{source_id:path}/frame")
def thermal_frame(source_id: str, t: float) -> Response:
    payload = session().ring.camera_frame(source_id, int(round(t)))
    if payload is None:
        raise HTTPException(404, "no frame")
    return Response(content=payload, media_type="application/octet-stream")


@app.get("/api/session/audio/{source_id:path}/pcm")
def audio_pcm(source_id: str, t0: float, t1: float) -> Response:
    result = session().ring.audio_pcm(source_id, int(round(t0)), int(round(t1)))
    if result is None:
        raise HTTPException(404, "no audio")
    rate, samples = result
    return Response(
        content=samples.tobytes(order="C"),
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(rate), "X-Samples": str(int(samples.size))},
    )


@app.get("/api/session/audio/{source_id:path}/waveform")
def audio_waveform(source_id: str, t0: float, t1: float) -> dict:
    env = session().ring.audio_envelope(source_id, int(round(t0)), int(round(t1)))
    if env is None:
        raise HTTPException(404, "no audio")
    return env


@app.get("/api/profiles")
def list_profiles() -> dict:
    return {"profiles": session().profiles.list()}


@app.get("/api/profiles/{name}")
def load_profile(name: str) -> dict:
    try:
        return session().profiles.load(name)
    except FileNotFoundError:
        raise HTTPException(404, "profile not found") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/profiles")
def save_profile(body: ProfilePayload) -> dict:
    try:
        return session().profiles.save(body.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.delete("/api/profiles/{name}")
def delete_profile(name: str) -> dict:
    try:
        session().profiles.delete(name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True}


@app.get("/api/captures")
def list_captures() -> dict:
    return {"captures": persist.list_captures(session().captures_dir)}


@app.post("/api/captures")
def save_capture(body: CaptureName) -> dict:
    s = session()
    if s.recording:
        raise HTTPException(409, "stop recording before saving")
    t_min, _, used, _ = s.ring.snapshot_status()
    if t_min is None or used <= 0:
        raise HTTPException(400, "nothing to save")
    try:
        meta = persist.save_capture(s.ring, s.captures_dir, body.name)
    except FileExistsError:
        raise HTTPException(409, "a capture with that name already exists") from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    s.dirty = False
    return meta


@app.post("/api/captures/{name}/open")
def open_capture(name: str) -> dict:
    s = session()
    if s.recording:
        raise HTTPException(409, "stop recording before opening a capture")
    try:
        meta = persist.load_capture(s.ring, s.captures_dir, name)
    except FileNotFoundError:
        raise HTTPException(404, "capture not found") from None
    except MemoryError as exc:
        raise HTTPException(413, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    s.dirty = False
    return {**get_session(), "opened": meta.get("name")}


@app.websocket("/ws/live/{source_id:path}")
async def live_ws(ws: WebSocket, source_id: str) -> None:
    await ws.accept()
    s = session()
    queue = s.hub.subscribe(source_id)
    try:
        while True:
            payload = await queue.get()
            if isinstance(payload, (bytes, bytearray)):
                await ws.send_bytes(payload)
            else:
                await ws.send_json(payload)
    except WebSocketDisconnect:
        pass
    finally:
        s.hub.unsubscribe(source_id, queue)


@app.websocket("/ws/presence")
async def presence_ws(ws: WebSocket) -> None:
    await ws.accept()
    s = session()
    peer = None
    try:
        hello = await ws.receive_json()
        name = str(hello.get("name") or "anon")
        peer = await s.presence.join(name)
        await ws.send_json(
            {
                "type": "hello",
                "you": peer.public(),
                "peers": s.presence.list_public(),
                **s.presence.layout,
            }
        )

        async def sender() -> None:
            while True:
                msg = await peer.queue.get()
                await ws.send_json(msg)

        send_task = asyncio.create_task(sender())
        try:
            while True:
                msg = await ws.receive_json()
                if msg.get("type") == "viewport":
                    await s.presence.update_viewport(
                        peer.id,
                        bool(msg.get("live", True)),
                        msg.get("center"),
                        msg.get("duration"),
                        bool(msg.get("playing", False)),
                    )
                elif msg.get("type") == "layout":
                    await s.presence.set_layout(msg, origin=peer.id)
        finally:
            send_task.cancel()
    except WebSocketDisconnect:
        pass
    finally:
        if peer is not None:
            await s.presence.leave(peer.id)
