from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from measync.session import Session

log = logging.getLogger(__name__)

RETRY_S = 0.5
READ_FAIL_LIMIT = 12
AUDIO_STALL_S = 1.5


def _video_present(index: int) -> bool:
    return Path(f"/dev/video{index}").exists()


class CaptureHandle:
    def __init__(self, source_id: str, kind: str, label: str, index: int) -> None:
        self.source_id = source_id
        self.kind = kind
        self.label = label
        self.index = index
        self.sample_rate: int | None = None
        self.online = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, session: "Session") -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        runners = {
            "camera": self._run_camera,
            "audio": self._run_audio,
            "thermal": self._run_thermal,
        }
        target = runners.get(self.kind)
        if target is None:
            log.error("unknown source kind %s for %s", self.kind, self.source_id)
            return
        self._thread = threading.Thread(target=target, args=(session,), name=self.source_id, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None
        self.online = False

    def _set_online(self, session: "Session", online: bool) -> None:
        if self.online == online:
            return
        self.online = online
        if online:
            log.info("%s online", self.source_id)
            return
        session.hub.publish_offline(self.source_id)
        log.info("%s offline", self.source_id)

    def _sleep(self, seconds: float) -> None:
        self._stop.wait(seconds)

    def _run_camera(self, session: "Session") -> None:
        try:
            import cv2
        except ImportError:
            log.error("OpenCV missing; cannot capture %s", self.source_id)
            return

        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), 80]
        while not self._stop.is_set():
            if not _video_present(self.index):
                self._set_online(session, False)
                self._sleep(RETRY_S)
                continue
            cap = cv2.VideoCapture(self.index, cv2.CAP_V4L2)
            if not cap.isOpened():
                self._set_online(session, False)
                self._sleep(RETRY_S)
                continue
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            log.info("Camera %s started", self.source_id)
            fails = 0
            try:
                while not self._stop.is_set():
                    if not _video_present(self.index):
                        break
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        fails += 1
                        if fails >= READ_FAIL_LIMIT:
                            break
                        time.sleep(0.05)
                        continue
                    fails = 0
                    ok, buf = cv2.imencode(".jpg", frame, encode_params)
                    if not ok:
                        continue
                    jpeg = buf.tobytes()
                    t_ns = time.monotonic_ns()
                    self._set_online(session, True)
                    session.hub.publish(self.source_id, jpeg)
                    if session.recording:
                        session.ring.append_camera(self.source_id, self.label, t_ns, jpeg)
                        session.dirty = True
            finally:
                cap.release()
                log.info("Camera %s stopped", self.source_id)
            self._set_online(session, False)
            self._sleep(0.25)

    def _run_thermal(self, session: "Session") -> None:
        try:
            import cv2
        except ImportError:
            log.error("OpenCV missing; cannot capture %s", self.source_id)
            return

        from measync.thermal import decode_temperature, pack_snapshot, render_jpeg

        while not self._stop.is_set():
            if not _video_present(self.index):
                self._set_online(session, False)
                self._sleep(RETRY_S)
                continue
            cap = cv2.VideoCapture(self.index, cv2.CAP_V4L2)
            if not cap.isOpened():
                self._set_online(session, False)
                self._sleep(RETRY_S)
                continue
            cap.set(cv2.CAP_PROP_CONVERT_RGB, 0)
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 256)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 384)
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"YUYV"))
            log.info("Thermal %s started", self.source_id)
            fails = 0
            try:
                while not self._stop.is_set():
                    if not _video_present(self.index):
                        break
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        fails += 1
                        if fails >= READ_FAIL_LIMIT:
                            break
                        time.sleep(0.05)
                        continue
                    temp = decode_temperature(frame)
                    if temp is None:
                        fails += 1
                        if fails >= READ_FAIL_LIMIT:
                            break
                        time.sleep(0.05)
                        continue
                    fails = 0
                    jpeg = render_jpeg(temp)
                    if not jpeg:
                        continue
                    payload = pack_snapshot(temp, jpeg)
                    t_ns = time.monotonic_ns()
                    self._set_online(session, True)
                    session.hub.publish(self.source_id, payload)
                    if session.recording:
                        session.ring.append_camera(self.source_id, self.label, t_ns, payload, kind="thermal")
                        session.dirty = True
            finally:
                cap.release()
                log.info("Thermal %s stopped", self.source_id)
            self._set_online(session, False)
            self._sleep(0.25)

    def _run_audio(self, session: "Session") -> None:
        try:
            import sounddevice as sd
        except (ImportError, OSError):
            log.error("sounddevice missing; cannot capture %s", self.source_id)
            return

        while not self._stop.is_set():
            broken = threading.Event()
            last_block = [time.monotonic()]
            try:
                info = sd.query_devices(self.index)
                rate = int(info.get("default_samplerate") or 44100)
            except Exception:
                self._set_online(session, False)
                self._sleep(RETRY_S)
                continue
            self.sample_rate = rate
            blocksize = max(1, int(rate * 0.04))

            def callback(indata, frames, time_info, status) -> None:  # noqa: ANN001
                last_block[0] = time.monotonic()
                if status:
                    log.debug("audio status %s: %s", self.source_id, status)
                    text = str(status).lower()
                    if "invalid" in text or "abort" in text or "disconnect" in text:
                        broken.set()
                if indata.ndim > 1:
                    samples = np.mean(indata, axis=1).astype(np.float32, copy=False)
                else:
                    samples = np.ascontiguousarray(indata, dtype=np.float32)
                t_ns = time.monotonic_ns()
                peak_min = float(samples.min()) if samples.size else 0.0
                peak_max = float(samples.max()) if samples.size else 0.0
                self._set_online(session, True)
                session.hub.publish(
                    self.source_id,
                    {"t_ns": t_ns, "min": peak_min, "max": peak_max, "sample_rate": rate},
                )
                if session.recording:
                    session.ring.append_audio(self.source_id, self.label, rate, t_ns, samples)
                    session.dirty = True

            log.info("Audio %s started @ %s Hz", self.source_id, rate)
            try:
                with sd.InputStream(
                    device=self.index,
                    channels=1,
                    samplerate=rate,
                    dtype="float32",
                    blocksize=blocksize,
                    callback=callback,
                ):
                    last_block[0] = time.monotonic()
                    while not self._stop.is_set() and not broken.is_set():
                        try:
                            sd.query_devices(self.index)
                        except Exception:
                            break
                        if time.monotonic() - last_block[0] > AUDIO_STALL_S:
                            break
                        time.sleep(0.1)
            except Exception:
                log.exception("Audio capture failed for %s", self.source_id)
            log.info("Audio %s stopped", self.source_id)
            self._set_online(session, False)
            self._sleep(RETRY_S)
