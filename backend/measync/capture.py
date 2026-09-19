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


def _stream_rate(data: dict, fallback: int | None) -> int:
    from measync.joulescope import DEFAULT_RATE

    info = data.get("time") if isinstance(data, dict) else None
    raw = None
    if isinstance(info, dict):
        freq = info.get("sampling_frequency") or info.get("output_sampling_frequency")
        raw = freq.get("value") if isinstance(freq, dict) else freq
    try:
        rate = int(raw) if raw is not None else int(fallback or DEFAULT_RATE)
    except (TypeError, ValueError):
        rate = int(fallback or DEFAULT_RATE)
    return rate if rate > 0 else DEFAULT_RATE


class CaptureHandle:
    def __init__(self, source_id: str, kind: str, label: str, index: int) -> None:
        self.source_id = source_id
        self.kind = kind
        self.label = label
        self.index = index
        self.sample_rate: int | None = None
        self.sample_rates: list[int] = []
        self.output_on: bool | None = None
        self.online = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._wanted_rate: int | None = None
        self._serial: str | None = None
        self._rate_lock = threading.Lock()
        if kind == "joulescope":
            from measync.joulescope import DEFAULT_RATE, JOULESCOPE_RATES

            self.sample_rate = DEFAULT_RATE
            self.sample_rates = list(JOULESCOPE_RATES)
            self._wanted_rate = DEFAULT_RATE
            self.output_on = True
            self._wanted_output = True

    def start(self, session: "Session") -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        runners = {
            "camera": self._run_camera,
            "audio": self._run_audio,
            "thermal": self._run_thermal,
            "joulescope": self._run_joulescope,
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
            self._thread.join(timeout=4.0)
            self._thread = None
        self.online = False

    def set_sample_rate(self, sample_rate: int) -> None:
        with self._rate_lock:
            rates = self.sample_rates
            if rates and sample_rate not in rates:
                raise ValueError(f"unsupported sample rate {sample_rate}")
            self._wanted_rate = int(sample_rate)
            self.sample_rate = int(sample_rate)

    def set_output(self, output_on: bool) -> None:
        if self.kind != "joulescope":
            raise ValueError("output control is only available on Joulescope sources")
        with self._rate_lock:
            self.output_on = bool(output_on)
            self._wanted_output = bool(output_on)

    def _wanted_sample_rate(self) -> int | None:
        with self._rate_lock:
            return self._wanted_rate

    def _wanted_output_on(self) -> bool:
        with self._rate_lock:
            return bool(self._wanted_output) if self.kind == "joulescope" else True

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
                    session.store_camera(self.source_id, self.label, t_ns, jpeg)
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
                    session.store_camera(self.source_id, self.label, t_ns, payload, kind="thermal")
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
                peak_mean = float(samples.mean()) if samples.size else 0.0
                self._set_online(session, True)
                session.hub.publish(
                    self.source_id,
                    {
                        "t_ns": t_ns,
                        "mean": peak_mean,
                        "min": peak_min,
                        "max": peak_max,
                        "sample_rate": rate,
                    },
                )
                session.store_audio(self.source_id, self.label, rate, t_ns, samples)

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

    def _run_joulescope(self, session: "Session") -> None:
        from measync.joulescope import (
            DEFAULT_RATE,
            LIVE_BLOCK_NS,
            apply_output,
            available_sample_span,
            device_rates,
            device_serial,
            find_device,
            SampleClock,
        )

        class Sink:
            def __init__(self, handle: CaptureHandle) -> None:
                self.handle = handle
                self.session = session
                self._next: int | None = None
                self._clock = SampleClock()
                self._live_i: list[np.ndarray] = []
                self._live_v: list[np.ndarray] = []
                self._live_p: list[np.ndarray] = []
                self._live_t0: int | None = None

            def stream_notify(self, stream_buffer) -> bool:  # noqa: ANN001
                try:
                    buf_start, buf_end = stream_buffer.sample_id_range
                    span = available_sample_span(self._next, buf_start, buf_end)
                    if span is None:
                        return False
                    get_start, get_end = span
                    data = stream_buffer.samples_get(get_start, get_end, fields=["current", "voltage", "power"])
                    current = np.ascontiguousarray(data["signals"]["current"]["value"], dtype=np.float32)
                    voltage = np.ascontiguousarray(data["signals"]["voltage"]["value"], dtype=np.float32)
                    power = np.ascontiguousarray(data["signals"]["power"]["value"], dtype=np.float32)
                    meta = data.get("time") if isinstance(data, dict) else None
                    ids = meta.get("sample_id_range") if isinstance(meta, dict) else None
                    raw_ids = ids.get("value") if isinstance(ids, dict) else ids
                    if isinstance(raw_ids, (list, tuple)) and len(raw_ids) >= 2:
                        actual_start, actual_end = int(raw_ids[0]), int(raw_ids[1])
                    else:
                        actual_start, actual_end = get_start, get_end
                    n = min(current.size, voltage.size, power.size, max(0, actual_end - actual_start))
                    self._next = actual_end if actual_end > get_start else get_end
                    if n <= 0:
                        return False
                    current, voltage, power = current[:n], voltage[:n], power[:n]
                    t_ns = time.monotonic_ns()
                    rate = _stream_rate(data, self.handle.sample_rate)
                    self.handle._set_online(session, True)
                    t_end = self._clock.stamp_end(actual_start, n, rate, t_ns)
                    session.store_joulescope(
                        self.handle.source_id, self.handle.label, rate, t_end, current, voltage, power
                    )
                    self._accum_live(t_ns, current, voltage, power, rate)
                except Exception:
                    log.exception("Joulescope stream failed for %s", self.handle.source_id)
                    return True
                return False

            def _accum_live(
                self, t_ns: int, current: np.ndarray, voltage: np.ndarray, power: np.ndarray, rate: int
            ) -> None:
                if self._live_t0 is None:
                    self._live_t0 = t_ns
                self._live_i.append(current)
                self._live_v.append(voltage)
                self._live_p.append(power)
                elapsed = t_ns - self._live_t0
                count = int(sum(chunk.size for chunk in self._live_i))
                if elapsed < LIVE_BLOCK_NS and count < max(1, rate // 50):
                    return
                self._flush_live(t_ns, rate)

            def _flush_live(self, t_ns: int, rate: int) -> None:
                if not self._live_i:
                    return
                current = np.concatenate(self._live_i)
                voltage = np.concatenate(self._live_v)
                power = np.concatenate(self._live_p)
                self._live_i, self._live_v, self._live_p = [], [], []
                self._live_t0 = None

                def stats(arr: np.ndarray) -> dict[str, float]:
                    if arr.size == 0:
                        return {"mean": 0.0, "min": 0.0, "max": 0.0}
                    return {"mean": float(arr.mean()), "min": float(np.nanmin(arr)), "max": float(np.nanmax(arr))}

                session.hub.publish(
                    self.handle.source_id,
                    {
                        "t_ns": t_ns,
                        "current": stats(current),
                        "voltage": stats(voltage),
                        "power": stats(power),
                        "sample_rate": rate,
                    },
                )

            def close(self) -> None:
                return None

        while not self._stop.is_set():
            device = find_device(self.index, self._serial)
            if device is None:
                self._set_online(session, False)
                self._sleep(RETRY_S)
                continue
            broken = threading.Event()

            def on_event(event, message) -> None:  # noqa: ANN001
                log.warning("%s event %s: %s", self.source_id, event, message)
                broken.set()

            def on_stop(*_args, **_kwargs) -> None:
                broken.set()

            sink = Sink(self)
            try:
                device.open(event_callback_fn=on_event)
                self._serial = device_serial(device)
                rates = device_rates(device)
                self.sample_rates = rates
                wanted = self._wanted_sample_rate()
                if wanted is None or (rates and wanted not in rates):
                    wanted = DEFAULT_RATE if DEFAULT_RATE in rates else (rates[0] if rates else DEFAULT_RATE)
                    self.set_sample_rate(wanted)
                try:
                    device.parameter_set("buffer_duration", 0.5)
                except Exception:
                    pass
                try:
                    device.parameter_set("sampling_frequency", wanted)
                except Exception:
                    log.exception("%s failed to set sampling_frequency %s", self.source_id, wanted)
                current_rate = int(getattr(device, "sampling_frequency", None) or wanted)
                self.sample_rate = current_rate
                applied_output: bool | None = None
                try:
                    apply_output(device, self._wanted_output_on())
                    applied_output = self._wanted_output_on()
                except Exception:
                    log.exception("%s failed to apply output", self.source_id)
                device.stream_process_register(sink)
                device.start(stop_fn=on_stop)
                log.info(
                    "Joulescope %s started @ %s Hz output=%s",
                    self.source_id,
                    current_rate,
                    self._wanted_output_on(),
                )
                while not self._stop.is_set() and not broken.is_set():
                    nxt = self._wanted_sample_rate()
                    if nxt is not None and nxt != current_rate:
                        try:
                            device.stop()
                            device.parameter_set("sampling_frequency", nxt)
                            current_rate = int(getattr(device, "sampling_frequency", None) or nxt)
                            self.sample_rate = current_rate
                            sink._next = None
                            sink._clock.reset()
                            apply_output(device, self._wanted_output_on())
                            applied_output = self._wanted_output_on()
                            device.start(stop_fn=on_stop)
                            log.info("Joulescope %s rate -> %s Hz", self.source_id, current_rate)
                        except Exception:
                            log.exception("%s failed to change sample rate", self.source_id)
                            broken.set()
                            break
                    nxt_output = self._wanted_output_on()
                    if nxt_output != applied_output:
                        try:
                            apply_output(device, nxt_output)
                            applied_output = nxt_output
                            log.info("Joulescope %s output=%s", self.source_id, nxt_output)
                        except Exception:
                            log.exception("%s failed to change output", self.source_id)
                    self._sleep(0.1)
            except Exception:
                log.exception("Joulescope capture failed for %s", self.source_id)
            finally:
                try:
                    device.stop()
                except Exception:
                    pass
                try:
                    device.stream_process_unregister(sink)
                except Exception:
                    pass
                try:
                    device.close()
                except Exception:
                    log.debug("Joulescope close failed for %s", self.source_id, exc_info=True)
                log.info("Joulescope %s stopped", self.source_id)
            self._set_online(session, False)
            self._sleep(RETRY_S)
