from pathlib import Path

import numpy as np

from measync.persist import load_capture, save_capture
from measync.ring import RingBuffer


def test_evicts_oldest_time_aligned():
    ring = RingBuffer(cap_bytes=5000)
    for i in range(40):
        t = 1_000_000 + i * 10_000
        ring.append_camera("camera:0", "cam", t, b"x" * 200)
        ring.append_audio("audio:0", "mic", 8000, t + 1, np.ones(20, dtype=np.float32))
    assert ring.used <= ring.cap_bytes
    t_min, t_max = ring.range_ns()
    assert t_min is not None and t_max is not None
    assert t_max > t_min
    cam_first = ring.camera["camera:0"].first_t()
    aud_first = ring.audio["audio:0"].first_t()
    assert cam_first is not None and aud_first is not None
    assert abs(cam_first - aud_first) < 50_000


def test_frame_and_waveform_and_roundtrip(tmp_path: Path):
    ring = RingBuffer(cap_bytes=10_000_000)
    for i in range(10):
        t = 1000 + i * 100
        ring.append_camera("camera:0", "cam", t, bytes([i]) * 32)
        ring.append_audio("audio:0", "mic", 8000, t, np.full(8, i / 10, dtype=np.float32))
    frame = ring.camera_frame("camera:0", 1450)
    assert frame is not None and frame[0] == 4
    env = ring.audio_envelope("audio:0", 1000, 2000)
    assert env is not None and len(env["t"]) == 10
    meta = save_capture(ring, tmp_path, "take-one")
    other = RingBuffer(cap_bytes=10_000_000)
    loaded = load_capture(other, tmp_path, "take-one")
    assert loaded["name"] == "take-one"
    assert other.camera_frame("camera:0", 1450) == frame
    assert meta["bytes_used"] == other.used


def test_thermal_decode_and_persist(tmp_path: Path):
    from measync.thermal import decode_temperature, pack_snapshot, unpack_snapshot

    frame = np.zeros((384, 256, 2), dtype=np.uint8)
    raw = int(round((25.0 + 273.15) * 64))
    frame[192:, :, 0] = raw & 0xFF
    frame[192:, :, 1] = (raw >> 8) & 0xFF
    hot = int(round((40.0 + 273.15) * 64))
    frame[192, 10, 0] = hot & 0xFF
    frame[192, 10, 1] = (hot >> 8) & 0xFF
    temp = decode_temperature(frame)
    assert temp is not None and temp.shape == (192, 256)
    assert abs(float(temp[96, 128]) - 25.0) < 0.05
    assert abs(float(temp[0, 10]) - 40.0) < 0.05
    payload = pack_snapshot(temp, b"\xff\xd8fakejpeg")
    unpacked = unpack_snapshot(payload)
    assert unpacked is not None
    assert abs(unpacked.min_c - 25.0) < 0.05
    assert abs(unpacked.max_c - 40.0) < 0.05
    assert abs(unpacked.center_c - 25.0) < 0.05
    assert unpacked.jpeg == b"\xff\xd8fakejpeg"
    assert unpacked.max_x == 10 and unpacked.max_y == 0
    assert unpacked.min_x == 0 and unpacked.min_y == 0

    ring = RingBuffer(cap_bytes=10_000_000)
    ring.append_camera("thermal:2", "Infiray P2 Pro (2)", 1000, payload, kind="thermal")
    meta = save_capture(ring, tmp_path, "thermal-take")
    assert meta["sources"][0]["kind"] == "thermal"
    other = RingBuffer(cap_bytes=10_000_000)
    loaded = load_capture(other, tmp_path, "thermal-take")
    assert loaded["name"] == "thermal-take"
    assert other.camera["thermal:2"].kind == "thermal"
    assert other.camera_frame("thermal:2", 1000) == payload


if __name__ == "__main__":
    import shutil

    test_evicts_oldest_time_aligned()
    dest = Path("/tmp/measync-test-captures")
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir()
    test_frame_and_waveform_and_roundtrip(dest)
    thermal_dest = dest / "thermal"
    thermal_dest.mkdir()
    test_thermal_decode_and_persist(thermal_dest)
    print("ok")
