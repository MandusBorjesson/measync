from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SENSOR_W = 256
SENSOR_H = 192
FRAME_H = SENSOR_H * 2
SNAPSHOT_MAGIC = b"THRM"
SNAPSHOT_HEADER_V1 = struct.Struct("<4sfff")  # magic, min_c, max_c, center_c
SNAPSHOT_HEADER = struct.Struct("<4sfffHHHH")  # v1 + min_x, min_y, max_x, max_y
RENDER_SCALE = 3
JPEG_SOI = b"\xff\xd8"

# Infiray P2 Pro and the same Realtek-UVC 256x384 family (Topdon TC001, etc.).
THERMAL_USB_LABELS: dict[tuple[int, int], str] = {
    (0x0BDA, 0x5830): "Infiray P2 Pro",
    (0x0BDA, 0x5840): "Infiray thermal",
}


def _usb_ids_for_video(index: int) -> tuple[int, int] | None:
    start = Path(f"/sys/class/video4linux/video{index}/device")
    if not start.exists():
        return None
    path = start.resolve()
    for parent in (path, *path.parents):
        vendor = parent / "idVendor"
        product = parent / "idProduct"
        if vendor.exists() and product.exists():
            try:
                return int(vendor.read_text().strip(), 16), int(product.read_text().strip(), 16)
            except ValueError:
                return None
    return None


def _v4l_device_index(index: int) -> int | None:
    path = Path(f"/sys/class/video4linux/video{index}/index")
    if not path.exists():
        return None
    try:
        return int(path.read_text().strip())
    except ValueError:
        return None


def infiray_symlink_index() -> int | None:
    link = Path("/dev/video-infiray")
    if not link.exists():
        return None
    try:
        name = link.resolve().name
    except OSError:
        return None
    suffix = name.removeprefix("video")
    if suffix.isdigit():
        return int(suffix)
    return None


def is_thermal_usb(index: int) -> bool:
    ids = _usb_ids_for_video(index)
    if ids in THERMAL_USB_LABELS:
        return True
    return infiray_symlink_index() == index


def is_thermal_capture(index: int) -> bool:
    if not is_thermal_usb(index):
        return False
    device_index = _v4l_device_index(index)
    return device_index in (None, 0)


def thermal_label(index: int) -> str:
    ids = _usb_ids_for_video(index)
    name = THERMAL_USB_LABELS.get(ids or (-1, -1), "Thermal camera")
    return f"{name} ({index})"


def decode_temperature(frame: np.ndarray) -> np.ndarray | None:
    """Return a 192x256 Celsius map from a 256x384 YUYV Infiray frame."""
    arr = np.asarray(frame)
    if arr.size == FRAME_H * SENSOR_W * 2:
        arr = arr.reshape(FRAME_H, SENSOR_W, 2)
    if arr.ndim != 3 or arr.shape[0] != FRAME_H or arr.shape[1] != SENSOR_W or arr.shape[2] != 2:
        return None
    raw = arr[SENSOR_H:, :, 0].astype(np.uint16) | (arr[SENSOR_H:, :, 1].astype(np.uint16) << 8)
    return raw.astype(np.float32) / 64.0 - 273.15


def extrema_pixels(temp: np.ndarray) -> tuple[int, int, int, int]:
    min_y, min_x = np.unravel_index(int(np.argmin(temp)), temp.shape)
    max_y, max_x = np.unravel_index(int(np.argmax(temp)), temp.shape)
    return int(min_x), int(min_y), int(max_x), int(max_y)


def render_jpeg(temp: np.ndarray) -> bytes:
    import cv2

    lo = float(np.min(temp))
    hi = float(np.max(temp))
    span = max(hi - lo, 1e-3)
    norm = np.clip((temp - lo) / span * 255.0, 0, 255).astype(np.uint8)
    color = cv2.applyColorMap(norm, cv2.COLORMAP_INFERNO)
    color = cv2.resize(
        color,
        (SENSOR_W * RENDER_SCALE, SENSOR_H * RENDER_SCALE),
        interpolation=cv2.INTER_NEAREST,
    )
    cy, cx = temp.shape[0] // 2, temp.shape[1] // 2
    cv2.drawMarker(
        color,
        (int(cx * RENDER_SCALE + RENDER_SCALE // 2), int(cy * RENDER_SCALE + RENDER_SCALE // 2)),
        (255, 255, 255),
        cv2.MARKER_CROSS,
        14,
        1,
        cv2.LINE_AA,
    )
    ok, buf = cv2.imencode(".jpg", color, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        return b""
    return buf.tobytes()


@dataclass
class ThermalSnapshot:
    min_c: float
    max_c: float
    center_c: float
    jpeg: bytes
    min_x: int | None = None
    min_y: int | None = None
    max_x: int | None = None
    max_y: int | None = None


def pack_snapshot(temp: np.ndarray, jpeg: bytes) -> bytes:
    min_c = float(np.min(temp))
    max_c = float(np.max(temp))
    center_c = float(temp[temp.shape[0] // 2, temp.shape[1] // 2])
    min_x, min_y, max_x, max_y = extrema_pixels(temp)
    return (
        SNAPSHOT_HEADER.pack(SNAPSHOT_MAGIC, min_c, max_c, center_c, min_x, min_y, max_x, max_y)
        + jpeg
    )


def unpack_snapshot(payload: bytes) -> ThermalSnapshot | None:
    if len(payload) < SNAPSHOT_HEADER_V1.size or payload[:4] != SNAPSHOT_MAGIC:
        return None
    if len(payload) >= SNAPSHOT_HEADER.size + 2 and payload[SNAPSHOT_HEADER.size : SNAPSHOT_HEADER.size + 2] == JPEG_SOI:
        magic, min_c, max_c, center_c, min_x, min_y, max_x, max_y = SNAPSHOT_HEADER.unpack_from(payload)
        return ThermalSnapshot(
            min_c=min_c,
            max_c=max_c,
            center_c=center_c,
            jpeg=payload[SNAPSHOT_HEADER.size :],
            min_x=int(min_x),
            min_y=int(min_y),
            max_x=int(max_x),
            max_y=int(max_y),
        )
    if payload[SNAPSHOT_HEADER_V1.size : SNAPSHOT_HEADER_V1.size + 2] == JPEG_SOI:
        magic, min_c, max_c, center_c = SNAPSHOT_HEADER_V1.unpack_from(payload)
        return ThermalSnapshot(
            min_c=min_c,
            max_c=max_c,
            center_c=center_c,
            jpeg=payload[SNAPSHOT_HEADER_V1.size :],
        )
    return None
