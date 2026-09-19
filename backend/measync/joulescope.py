from __future__ import annotations

import logging

from measync.models import Device

log = logging.getLogger(__name__)

# JS220 output rates (10 Hz–1 MHz). JS110 also accepts these via sampling_frequency.
JOULESCOPE_RATES = [
    10,
    20,
    50,
    100,
    200,
    500,
    1_000,
    2_000,
    5_000,
    10_000,
    20_000,
    50_000,
    100_000,
    200_000,
    500_000,
    1_000_000,
]
DEFAULT_RATE = 1_000
LIVE_BLOCK_NS = 20_000_000


def available_sample_span(
    next_id: int | None, buf_start: int | None, buf_end: int | None
) -> tuple[int, int] | None:
    """Return the unread [start, end) still in the instrument buffer.

    If we fell behind and the circular buffer wrapped, skip the missing ids
    rather than stamping the surviving samples onto the old range.
    """
    if buf_start is None or buf_end is None:
        return None
    start = int(buf_start) if next_id is None or next_id < buf_start else int(next_id)
    end = int(buf_end)
    if end <= start:
        return None
    return start, end


class SampleClock:
    """Map instrument sample ids onto a monotonic-ns axis at a fixed rate."""

    def __init__(self) -> None:
        self._origin_t: int | None = None
        self._origin_id: int | None = None
        self._origin_rate: int | None = None
        self._origin_dt: int = 1
        self._last_end: int | None = None

    def reset(self) -> None:
        self._origin_t = None
        self._origin_id = None
        self._origin_rate = None
        self._last_end = None

    def stamp_end(self, start_id: int, n: int, rate: int, t_ns: int) -> int:
        dt = max(1, int(round(1_000_000_000 / max(1, rate))))
        start_id = int(start_id)
        n = max(1, int(n))
        restart = (
            self._origin_t is None
            or self._origin_rate != rate
            or self._origin_id is None
            or start_id < self._origin_id
        )
        if not restart and self._origin_t is not None and self._origin_id is not None:
            tentative = int(self._origin_t + (start_id + n - 1 - self._origin_id) * self._origin_dt)
            if self._last_end is not None and tentative <= self._last_end:
                restart = True
        if restart:
            self._origin_t = int(t_ns) - (n - 1) * dt
            self._origin_id = start_id
            self._origin_rate = int(rate)
            self._origin_dt = dt
        assert self._origin_t is not None and self._origin_id is not None
        last_id = start_id + n - 1
        t_end = int(self._origin_t + (last_id - self._origin_id) * self._origin_dt)
        self._last_end = t_end
        return t_end


def apply_output(device: object, output_on: bool) -> None:
    """Connect or isolate the current port.

    ``output_on`` maps to ``i_range`` auto vs off, which opens the JS220
    current-path switch so a series-wired DUT loses power.
    """
    device.parameter_set("i_range", "auto" if output_on else "off")  # type: ignore[attr-defined]


def device_serial(device: object) -> str:
    serial = getattr(device, "serial_number", None)
    if serial:
        return str(serial)
    path = getattr(device, "device_path", None) or getattr(device, "path", None)
    if path:
        return str(path).rsplit("/", 1)[-1]
    return str(device)


def _model(device: object) -> str:
    model = getattr(device, "model", None)
    if model:
        return str(model).upper()
    name = type(device).__name__
    if "220" in name:
        return "JS220"
    if "110" in name:
        return "JS110"
    return "Joulescope"


def device_rates(device: object) -> list[int]:
    try:
        param = device.parameters("sampling_frequency")  # type: ignore[attr-defined]
        options = getattr(param, "options", None) or []
        rates: list[int] = []
        for opt in options:
            value = opt[1] if isinstance(opt, (tuple, list)) and len(opt) > 1 else opt
            if isinstance(value, (int, float)) and int(value) >= 10:
                rates.append(int(value))
        rates = sorted(set(rates))
        if rates:
            return rates
    except Exception:
        log.debug("could not read joulescope sampling_frequency options", exc_info=True)
    return list(JOULESCOPE_RATES)


def scan_devices() -> list[object]:
    try:
        import joulescope
    except ImportError:
        log.warning("joulescope package not installed; no Joulescope devices enumerated")
        return []
    try:
        return list(joulescope.scan())
    except Exception as exc:
        log.warning("Failed to scan Joulescopes: %s", exc)
        return []


def list_joulescopes() -> list[Device]:
    found: list[Device] = []
    for index, device in enumerate(scan_devices()):
        serial = device_serial(device)
        model = _model(device)
        found.append(
            Device(
                id=f"joulescope:{index}",
                kind="joulescope",
                label=f"{model} {serial} ({index})",
                index=index,
                sample_rates=device_rates(device),
            )
        )
    return found


def find_device(index: int, serial: str | None = None) -> object | None:
    devices = scan_devices()
    if serial:
        for device in devices:
            if device_serial(device) == serial:
                return device
    if 0 <= index < len(devices):
        return devices[index]
    return None
