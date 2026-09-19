from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SENSOR_W = 256
SENSOR_H = 192
SENSOR_PIXELS = SENSOR_W * SENSOR_H
FRAME_H = SENSOR_H * 2
SNAPSHOT_MAGIC = b"THRM"
SNAPSHOT_HEADER_V0 = struct.Struct("<4sfff")  # JPEG at 16
SNAPSHOT_HEADER_V1 = struct.Struct("<4sfffHHHH")  # JPEG at 24
SNAPSHOT_HEADER_V2 = struct.Struct("<4sfffHHHHII")  # jpeg_len, temp_len; JPEG at 32
SNAPSHOT_HEADER = SNAPSHOT_HEADER_V2
MAX_ZONES = 8
RENDER_SCALE = 3
JPEG_SOI = b"\xff\xd8"
TEMP_BLOB_SIZE = SENSOR_PIXELS * 2
COARSE_CELL = 8
COARSE_W = SENSOR_W // COARSE_CELL
COARSE_H = SENSOR_H // COARSE_CELL
COARSE_COUNT = COARSE_W * COARSE_H
COARSE_BYTES = COARSE_COUNT * 4  # min int16 + max int16

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
    temp: np.ndarray | None = None


ZoneRect = tuple[int, int, int, int]


def encode_temp_map(temp: np.ndarray) -> bytes:
    centi = np.clip(np.rint(np.asarray(temp, dtype=np.float32) * 100.0), -32768, 32767).astype(
        "<i2", copy=False
    )
    return zlib.compress(centi.tobytes(), 1)


def decode_temp_map(blob: bytes) -> np.ndarray | None:
    try:
        raw = zlib.decompress(blob)
    except zlib.error:
        return None
    if len(raw) != TEMP_BLOB_SIZE:
        return None
    return np.frombuffer(raw, dtype="<i2").reshape(SENSOR_H, SENSOR_W).astype(np.float32) / 100.0


def clamp_zone(x: int, y: int, w: int, h: int) -> ZoneRect | None:
    x0 = max(0, min(SENSOR_W - 1, int(x)))
    y0 = max(0, min(SENSOR_H - 1, int(y)))
    x1 = max(x0 + 1, min(SENSOR_W, x0 + max(1, int(w))))
    y1 = max(y0 + 1, min(SENSOR_H, y0 + max(1, int(h))))
    return x0, y0, x1 - x0, y1 - y0


def parse_zone_rects(raw: str | None) -> list[ZoneRect]:
    if not raw:
        return []
    out: list[ZoneRect] = []
    for part in raw.split(";"):
        part = part.strip()
        if not part:
            continue
        bits = part.split(",")
        if len(bits) != 4:
            continue
        try:
            x, y, w, h = (int(b) for b in bits)
        except ValueError:
            continue
        rect = clamp_zone(x, y, w, h)
        if rect is None:
            continue
        out.append(rect)
        if len(out) >= MAX_ZONES:
            break
    return out


def encode_coarse(temp: np.ndarray) -> bytes:
    blocks = np.asarray(temp, dtype=np.float32).reshape(COARSE_H, COARSE_CELL, COARSE_W, COARSE_CELL)
    mins = np.clip(np.rint(blocks.min(axis=(1, 3)) * 100.0), -32768, 32767).astype("<i2", copy=False)
    maxs = np.clip(np.rint(blocks.max(axis=(1, 3)) * 100.0), -32768, 32767).astype("<i2", copy=False)
    return mins.tobytes() + maxs.tobytes()


def decode_coarse(blob: bytes) -> tuple[np.ndarray, np.ndarray] | None:
    if len(blob) < COARSE_BYTES:
        return None
    mins = np.frombuffer(blob, dtype="<i2", count=COARSE_COUNT).reshape(COARSE_H, COARSE_W)
    maxs = np.frombuffer(blob, dtype="<i2", count=COARSE_COUNT, offset=COARSE_COUNT * 2).reshape(COARSE_H, COARSE_W)
    return mins.astype(np.float32) / 100.0, maxs.astype(np.float32) / 100.0


def peek_stats(payload: bytes) -> tuple[float, float, float] | None:
    if len(payload) < SNAPSHOT_HEADER_V0.size or payload[:4] != SNAPSHOT_MAGIC:
        return None
    min_c, max_c, center_c = struct.unpack_from("<fff", payload, 4)
    return float(min_c), float(max_c), float(center_c)


def peek_coarse(payload: bytes) -> tuple[np.ndarray, np.ndarray] | None:
    if len(payload) < SNAPSHOT_HEADER_V2.size + 2:
        return None
    jpeg_len, temp_len = struct.unpack_from("<II", payload, 24)
    jpeg_off = SNAPSHOT_HEADER_V2.size
    extra_off = jpeg_off + int(jpeg_len) + int(temp_len)
    if (
        int(jpeg_len) < 2
        or extra_off + COARSE_BYTES > len(payload)
        or payload[jpeg_off : jpeg_off + 2] != JPEG_SOI
    ):
        return None
    return decode_coarse(payload[extra_off : extra_off + COARSE_BYTES])


def zone_extrema_coarse(
    mins: np.ndarray, maxs: np.ndarray, x: int, y: int, w: int, h: int
) -> tuple[float, float] | None:
    rect = clamp_zone(x, y, w, h)
    if rect is None:
        return None
    x0, y0, width, height = rect
    c0 = x0 // COARSE_CELL
    r0 = y0 // COARSE_CELL
    c1 = min(COARSE_W - 1, (x0 + width - 1) // COARSE_CELL)
    r1 = min(COARSE_H - 1, (y0 + height - 1) // COARSE_CELL)
    patch_min = mins[r0 : r1 + 1, c0 : c1 + 1]
    patch_max = maxs[r0 : r1 + 1, c0 : c1 + 1]
    if patch_min.size == 0 or patch_max.size == 0:
        return None
    return float(np.min(patch_min)), float(np.max(patch_max))


def zone_extrema(
    temp: np.ndarray, x: int, y: int, w: int, h: int
) -> tuple[float, float, int, int, int, int] | None:
    rect = clamp_zone(x, y, w, h)
    if rect is None:
        return None
    x0, y0, width, height = rect
    patch = temp[y0 : y0 + height, x0 : x0 + width]
    if patch.size == 0:
        return None
    min_y, min_x = np.unravel_index(int(np.argmin(patch)), patch.shape)
    max_y, max_x = np.unravel_index(int(np.argmax(patch)), patch.shape)
    return (
        float(np.min(patch)),
        float(np.max(patch)),
        int(min_x + x0),
        int(min_y + y0),
        int(max_x + x0),
        int(max_y + y0),
    )


def pack_snapshot(temp: np.ndarray, jpeg: bytes) -> bytes:
    min_c = float(np.min(temp))
    max_c = float(np.max(temp))
    center_c = float(temp[temp.shape[0] // 2, temp.shape[1] // 2])
    min_x, min_y, max_x, max_y = extrema_pixels(temp)
    temp_blob = encode_temp_map(temp)
    return (
        SNAPSHOT_HEADER_V2.pack(
            SNAPSHOT_MAGIC,
            min_c,
            max_c,
            center_c,
            min_x,
            min_y,
            max_x,
            max_y,
            len(jpeg),
            len(temp_blob),
        )
        + jpeg
        + temp_blob
        + encode_coarse(temp)
    )


def _stats(
    min_c: float,
    max_c: float,
    center_c: float,
    jpeg: bytes,
    min_x: int | None = None,
    min_y: int | None = None,
    max_x: int | None = None,
    max_y: int | None = None,
    temp: np.ndarray | None = None,
) -> ThermalSnapshot:
    return ThermalSnapshot(
        min_c=float(min_c),
        max_c=float(max_c),
        center_c=float(center_c),
        jpeg=jpeg,
        min_x=None if min_x is None else int(min_x),
        min_y=None if min_y is None else int(min_y),
        max_x=None if max_x is None else int(max_x),
        max_y=None if max_y is None else int(max_y),
        temp=temp,
    )


def unpack_snapshot(payload: bytes, with_temp: bool = True) -> ThermalSnapshot | None:
    if len(payload) < SNAPSHOT_HEADER_V0.size or payload[:4] != SNAPSHOT_MAGIC:
        return None
    if len(payload) >= SNAPSHOT_HEADER_V2.size + 2:
        _magic, min_c, max_c, center_c, min_x, min_y, max_x, max_y, jpeg_len, temp_len = (
            SNAPSHOT_HEADER_V2.unpack_from(payload)
        )
        jpeg_off = SNAPSHOT_HEADER_V2.size
        end = jpeg_off + int(jpeg_len) + int(temp_len)
        if (
            int(jpeg_len) >= 2
            and int(temp_len) >= 0
            and end <= len(payload)
            and payload[jpeg_off : jpeg_off + 2] == JPEG_SOI
        ):
            jpeg = payload[jpeg_off : jpeg_off + int(jpeg_len)]
            temp = None
            if with_temp and int(temp_len) > 0:
                temp = decode_temp_map(payload[jpeg_off + int(jpeg_len) : end])
            return _stats(min_c, max_c, center_c, jpeg, min_x, min_y, max_x, max_y, temp)
    if (
        len(payload) >= SNAPSHOT_HEADER_V1.size + 2
        and payload[SNAPSHOT_HEADER_V1.size : SNAPSHOT_HEADER_V1.size + 2] == JPEG_SOI
    ):
        _magic, min_c, max_c, center_c, min_x, min_y, max_x, max_y = SNAPSHOT_HEADER_V1.unpack_from(payload)
        return _stats(
            min_c,
            max_c,
            center_c,
            payload[SNAPSHOT_HEADER_V1.size :],
            min_x,
            min_y,
            max_x,
            max_y,
        )
    if payload[SNAPSHOT_HEADER_V0.size : SNAPSHOT_HEADER_V0.size + 2] == JPEG_SOI:
        _magic, min_c, max_c, center_c = SNAPSHOT_HEADER_V0.unpack_from(payload)
        return _stats(min_c, max_c, center_c, payload[SNAPSHOT_HEADER_V0.size :])
    return None


def series_point(
    payload: bytes, zones: list[ZoneRect] | None = None
) -> dict | None:
    stats = peek_stats(payload)
    if stats is None:
        return None
    min_c, max_c, center_c = stats
    zone_stats: list[dict] = []
    rects = list(zones or ())
    coarse = peek_coarse(payload) if rects else None
    snap_temp = None
    for rect in rects:
        extra = None
        if coarse is not None:
            extra = zone_extrema_coarse(coarse[0], coarse[1], *rect)
            if extra is not None:
                zone_stats.append({"min": extra[0], "max": extra[1]})
                continue
        if snap_temp is None:
            unpacked = unpack_snapshot(payload, with_temp=True)
            snap_temp = unpacked.temp if unpacked is not None else False
        if snap_temp is False or snap_temp is None:
            zone_stats.append({"min": None, "max": None})
            continue
        full = zone_extrema(snap_temp, *rect)
        if full is None:
            zone_stats.append({"min": None, "max": None})
        else:
            zone_stats.append({"min": full[0], "max": full[1]})
    return {
        "min": min_c,
        "max": max_c,
        "center": center_c,
        "zones": zone_stats,
    }
