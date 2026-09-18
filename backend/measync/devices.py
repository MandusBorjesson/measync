from __future__ import annotations

import logging
from pathlib import Path

from measync.models import Device
from measync.thermal import is_thermal_capture, is_thermal_usb, thermal_label

log = logging.getLogger(__name__)


def _camera_label(index: int) -> str:
    name_path = Path(f"/sys/class/video4linux/video{index}/name")
    if name_path.exists():
        label = name_path.read_text(encoding="utf-8", errors="ignore").strip()
        if label:
            return f"{label} ({index})"
    return f"Camera {index}"


def list_cameras(max_index: int = 16, busy: set[int] | None = None) -> list[Device]:
    try:
        import cv2
    except ImportError:
        log.warning("OpenCV not installed; no cameras enumerated")
        return []

    found: list[Device] = []
    video_nodes = sorted(Path("/dev").glob("video*"))
    indices: list[int] = []
    for node in video_nodes:
        suffix = node.name.removeprefix("video")
        if suffix.isdigit():
            indices.append(int(suffix))
    if not indices:
        indices = list(range(max_index))

    busy = busy or set()
    for index in indices:
        if is_thermal_usb(index):
            continue
        if index in busy:
            found.append(
                Device(id=f"camera:{index}", kind="camera", label=_camera_label(index), index=index)
            )
            continue
        cap = cv2.VideoCapture(index, cv2.CAP_V4L2)
        try:
            if not cap.isOpened():
                continue
            width = cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0
            if width <= 0:
                continue
            found.append(
                Device(
                    id=f"camera:{index}",
                    kind="camera",
                    label=_camera_label(index),
                    index=index,
                )
            )
        except Exception as exc:
            log.debug("skip camera %s: %s", index, exc)
        finally:
            cap.release()
    return found


def list_thermals() -> list[Device]:
    found: list[Device] = []
    video_nodes = sorted(Path("/dev").glob("video*"))
    seen: set[int] = set()
    for node in video_nodes:
        suffix = node.name.removeprefix("video")
        if not suffix.isdigit():
            continue
        index = int(suffix)
        if index in seen or not is_thermal_capture(index):
            continue
        seen.add(index)
        found.append(
            Device(id=f"thermal:{index}", kind="thermal", label=thermal_label(index), index=index)
        )
    return found


def list_mics() -> list[Device]:
    try:
        import sounddevice as sd
    except (ImportError, OSError) as exc:
        log.warning("sounddevice unavailable; no mics enumerated (%s)", exc)
        return []

    found: list[Device] = []
    try:
        devices = sd.query_devices()
    except Exception as exc:
        log.warning("Failed to query audio devices: %s", exc)
        return []

    for index, dev in enumerate(devices):
        if int(dev.get("max_input_channels") or 0) <= 0:
            continue
        name = str(dev.get("name") or f"Mic {index}")
        found.append(
            Device(id=f"audio:{index}", kind="audio", label=f"{name} ({index})", index=index)
        )
    return found


def list_devices(busy_cameras: set[int] | None = None) -> list[Device]:
    return [*list_thermals(), *list_cameras(busy=busy_cameras), *list_mics()]
