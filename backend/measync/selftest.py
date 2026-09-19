from pathlib import Path

import numpy as np

from measync.persist import load_capture, save_capture
from measync.ring import RingBuffer


def test_bucket_series_step_and_bands():
    from measync.graph import bucket_series

    t = np.arange(0, 100, dtype=np.int64)
    y = np.arange(0, 100, dtype=np.float64)
    one = bucket_series(t, y, 0, 100, max_points=200)
    assert len(one["t"]) == 100
    assert one["mean"] == one["min"] == one["max"]
    many = bucket_series(t, y, 0, 100, max_points=10)
    assert 8 <= len(many["t"]) <= 12
    for mean, lo, hi in zip(many["mean"], many["min"], many["max"], strict=True):
        assert lo is not None and hi is not None and mean is not None
        assert lo <= mean <= hi
        assert hi > lo
    gaps = bucket_series(t, [np.nan] * 50 + list(range(50)), 0, 100, max_points=200)
    assert gaps["mean"][0] == 0.0
    assert gaps["t"][0] == 50


def test_sample_times_follow_instrument_rate():
    from measync.ring import RingBuffer, _sample_times

    ts = _sample_times(10_000_000, 11, 1000)
    assert int(ts[-1]) == 10_000_000
    assert int(ts[0]) == 0
    assert np.all(np.diff(ts) == 1_000_000)

    ring = RingBuffer(cap_bytes=10_000_000)
    ring.append_joulescope(
        "joulescope:0",
        "js",
        1000,
        1_000_000_000,
        np.arange(10, dtype=np.float32),
        np.full(10, 3.3, dtype=np.float32),
        np.arange(10, dtype=np.float32),
    )
    ring.append_joulescope(
        "joulescope:0",
        "js",
        1000,
        1_500_000_000,
        np.arange(10, 20, dtype=np.float32),
        np.full(10, 3.3, dtype=np.float32),
        np.arange(10, 20, dtype=np.float32),
    )
    track = ring.joulescope["joulescope:0"]
    first = _sample_times(track.t[0], 10, 1000)
    second = _sample_times(track.t[1], 10, 1000)
    assert int(first[-1] - first[0]) == 9_000_000
    assert int(second[0] - first[-1]) > 400_000_000
    series = track.series(int(first[0]), int(second[-1]), max_points=400)
    assert len(series["t"]) > 0


def test_available_sample_span_skips_wrapped_ids():
    from measync.joulescope import SampleClock, available_sample_span

    assert available_sample_span(None, 10, 20) == (10, 20)
    assert available_sample_span(12, 10, 20) == (12, 20)
    assert available_sample_span(5, 10, 20) == (10, 20)
    assert available_sample_span(20, 10, 20) is None
    assert available_sample_span(0, None, 20) is None

    clock = SampleClock()
    t0 = 1_000_000_000
    first = clock.stamp_end(0, 10, 1000, t0)
    second = clock.stamp_end(10, 10, 1000, t0 + 20_000_000)
    assert second > first
    # Buffer wrap: surviving samples belong to high ids, not the stale cursor.
    late = clock.stamp_end(10_000, 10, 1000, t0 + 50_000_000)
    assert late > second
    # Backward ids re-anchor instead of painting into the past.
    clock2 = SampleClock()
    a = clock2.stamp_end(1000, 10, 1000, t0)
    b = clock2.stamp_end(0, 10, 1000, t0 + 5_000_000)
    assert b > a


def test_overlapping_joulescope_chunk_does_not_rewrite_history():
    from measync.ring import RingBuffer, _sample_times

    ring = RingBuffer(cap_bytes=10_000_000)
    old = np.full(100, 0.2, dtype=np.float32)
    new = np.zeros(100, dtype=np.float32)
    ring.append_joulescope("joulescope:0", "js", 1000, 100_000_000, old, old, old)
    ring.append_joulescope("joulescope:0", "js", 1000, 100_000_000, new, new, new)
    track = ring.joulescope["joulescope:0"]
    first = _sample_times(track.t[0], 100, 1000)
    second = _sample_times(track.t[1], 100, 1000)
    assert int(second[0]) > int(first[-1])
    series = track.series(int(first[0]), int(second[-1]), max_points=400)
    assert series["raw"] is True
    currents = [v for v in series["current"]["mean"] if v is not None]
    assert currents[0] is not None and currents[0] > 0.1
    assert currents[-1] == 0.0
    flips = sum(1 for a, b in zip(currents, currents[1:]) if a != b)
    assert flips == 1


def test_evicts_oldest_time_aligned():
    ring = RingBuffer(cap_bytes=8000)
    for i in range(40):
        t = 1_000_000_000 + i * 10_000_000
        ring.append_camera("camera:0", "cam", t, b"x" * 200)
        ring.append_audio("audio:0", "mic", 8000, t + 1, np.ones(20, dtype=np.float32))
        ring.append_joulescope(
            "joulescope:0",
            "js",
            1000,
            t + 2,
            np.full(4, 0.01, dtype=np.float32),
            np.full(4, 3.3, dtype=np.float32),
            np.full(4, 0.033, dtype=np.float32),
        )
    assert ring.used <= ring.cap_bytes
    t_min, t_max = ring.range_ns()
    assert t_min is not None and t_max is not None
    assert t_max > t_min
    cam_first = ring.camera["camera:0"].first_t()
    aud_first = ring.audio["audio:0"].first_t()
    js_first = ring.joulescope["joulescope:0"].first_t()
    assert cam_first is not None and aud_first is not None and js_first is not None
    assert abs(cam_first - aud_first) < 15_000_000
    assert abs(cam_first - js_first) < 15_000_000


def test_frame_and_waveform_and_roundtrip(tmp_path: Path):
    ring = RingBuffer(cap_bytes=10_000_000)
    for i in range(10):
        t = 1000 + i * 100
        ring.append_camera("camera:0", "cam", t, bytes([i]) * 32)
        ring.append_audio("audio:0", "mic", 8000, t, np.full(8, i / 10, dtype=np.float32))
    frame = ring.camera_frame("camera:0", 1450)
    assert frame is not None and frame[0] == 4
    env = ring.audio_envelope("audio:0", 1000, 2000)
    assert env is not None and len(env["t"]) > 0
    assert "mean" in env and "min" in env and "max" in env
    assert env["mean"][0] == env["min"][0] == env["max"][0]
    wide = ring.audio_envelope("audio:0", 1000, 2000, max_points=4)
    assert wide is not None and 0 < len(wide["t"]) <= 8
    if len(wide["t"]) < 10:
        assert wide["min"][0] <= wide["mean"][0] <= wide["max"][0]
    meta = save_capture(ring, tmp_path, "take-one")
    other = RingBuffer(cap_bytes=10_000_000)
    loaded = load_capture(other, tmp_path, "take-one")
    assert loaded["name"] == "take-one"
    assert other.camera_frame("camera:0", 1450) == frame
    assert meta["bytes_used"] == other.used


def test_thermal_decode_and_persist(tmp_path: Path):
    from measync.thermal import (
        SNAPSHOT_HEADER_V1,
        SNAPSHOT_MAGIC,
        decode_temperature,
        pack_snapshot,
        unpack_snapshot,
        zone_extrema,
    )

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
    assert unpacked.temp is not None
    assert abs(float(unpacked.temp[0, 10]) - 40.0) < 0.02
    extra = zone_extrema(unpacked.temp, 8, 0, 6, 4)
    assert extra is not None
    assert abs(extra[1] - 40.0) < 0.02
    assert extra[4] == 10 and extra[5] == 0
    from measync.thermal import peek_coarse, zone_extrema_coarse

    grid = peek_coarse(payload)
    assert grid is not None
    zc = zone_extrema_coarse(grid[0], grid[1], 8, 0, 6, 4)
    assert zc is not None and abs(zc[1] - 40.0) < 0.5

    legacy = SNAPSHOT_HEADER_V1.pack(SNAPSHOT_MAGIC, 25.0, 40.0, 25.0, 0, 0, 10, 0) + b"\xff\xd8old"
    old = unpack_snapshot(legacy)
    assert old is not None and old.jpeg == b"\xff\xd8old" and old.temp is None

    ring = RingBuffer(cap_bytes=10_000_000)
    for i in range(5):
        ring.append_camera("thermal:2", "Infiray P2 Pro (2)", 1000 + i * 100, payload, kind="thermal")
    series = ring.thermal_series("thermal:2", 1000, 2000, zones=[(8, 0, 6, 4), (100, 80, 10, 10)])
    assert series is not None and len(series["t"]) == 5
    assert abs(series["max"]["mean"][0] - 40.0) < 0.05
    assert abs(series["min"]["mean"][0] - 25.0) < 0.05
    assert abs(series["center"]["mean"][0] - 25.0) < 0.05
    assert series["max"]["min"][0] == series["max"]["max"][0]
    assert abs(series["zones"][0]["max"]["mean"][0] - 40.0) < 0.05
    assert abs(series["zones"][1]["max"]["mean"][0] - 25.0) < 0.05

    for i in range(40):
        ring.append_camera("thermal:2", "Infiray P2 Pro (2)", 10_000 + i * 100, payload, kind="thermal")
    condensed = ring.camera["thermal:2"].series(10_000, 20_000, max_points=10)
    assert condensed is not None and 0 < len(condensed["t"]) <= 10
    assert condensed["min"]["min"][0] <= condensed["min"]["mean"][0] <= condensed["min"]["max"][0]

    meta = save_capture(ring, tmp_path, "thermal-take")
    assert meta["sources"][0]["kind"] == "thermal"
    other = RingBuffer(cap_bytes=10_000_000)
    loaded = load_capture(other, tmp_path, "thermal-take")
    assert loaded["name"] == "thermal-take"
    assert other.camera["thermal:2"].kind == "thermal"
    assert other.camera_frame("thermal:2", 1000) == payload
    loaded_series = other.thermal_series("thermal:2", 1000, 2000, zones=[(8, 0, 6, 4)])
    assert loaded_series is not None and abs(loaded_series["zones"][0]["max"]["mean"][0] - 40.0) < 0.05


def test_joulescope_series_persist(tmp_path: Path):
    ring = RingBuffer(cap_bytes=10_000_000)
    for i in range(40):
        t = 1_000_000 + i * 1_000_000
        current = np.linspace(i, i + 1, 20, dtype=np.float32)
        voltage = np.full(20, 3.3, dtype=np.float32)
        power = current * voltage
        ring.append_joulescope("joulescope:0", "JS220", 1000, t, current, voltage, power)
    full = ring.joulescope_series("joulescope:0", 1_000_000, 50_000_000)
    assert full is not None and len(full["t"]) > 0
    condensed = ring.joulescope["joulescope:0"].series(1_000_000, 50_000_000, max_points=8)
    assert 0 < len(condensed["t"]) <= 12
    for i, mean in enumerate(condensed["current"]["mean"]):
        lo = condensed["current"]["min"][i]
        hi = condensed["current"]["max"][i]
        assert lo <= mean <= hi
        if len(condensed["t"]) < 40:
            assert hi > lo
    latest = RingBuffer(cap_bytes=10_000_000)
    t_end = 10_000_000
    latest.append_joulescope(
        "joulescope:0",
        "JS220",
        1000,
        t_end,
        np.full(20, 0.01, dtype=np.float32),
        np.full(20, 3.3, dtype=np.float32),
        np.full(20, 0.033, dtype=np.float32),
    )
    edge = latest.joulescope_series("joulescope:0", 0, t_end)
    assert edge is not None and len(edge["t"]) > 0
    meta = save_capture(ring, tmp_path, "js-take")
    assert meta["sources"][0]["kind"] == "joulescope"
    other = RingBuffer(cap_bytes=10_000_000)
    load_capture(other, tmp_path, "js-take")
    loaded = other.joulescope_series("joulescope:0", 1_000_000, 50_000_000)
    assert loaded is not None and len(loaded["t"]) > 0
    assert abs(loaded["voltage"]["mean"][0] - 3.3) < 0.05


def test_livehub_offline_drops_latest():
    from measync.livehub import LiveHub

    hub = LiveHub()
    hub.publish("camera:0", b"jpeg")
    assert hub.latest["camera:0"] == b"jpeg"
    hub.publish_offline("camera:0")
    assert "camera:0" not in hub.latest
    hub.publish("audio:0", {"t_ns": 1, "min": 0.0, "max": 0.1})
    hub.publish("audio:0", {"type": "offline"})
    assert "audio:0" not in hub.latest
    queued = hub.subscribe("audio:0")
    assert queued.get_nowait() == {"type": "offline"}


def test_joulescope_output():
    from measync.capture import CaptureHandle
    from measync.joulescope import apply_output

    class FakeDevice:
        def __init__(self) -> None:
            self.params: dict[str, object] = {}

        def parameter_set(self, name: str, value: object) -> None:
            self.params[name] = value

    device = FakeDevice()
    apply_output(device, False)
    assert device.params["i_range"] == "off"
    apply_output(device, True)
    assert device.params["i_range"] == "auto"

    handle = CaptureHandle("joulescope:0", "joulescope", "js", 0)
    assert handle.output_on is True
    handle.set_output(False)
    assert handle.output_on is False
    assert handle._wanted_output_on() is False
    camera = CaptureHandle("camera:0", "camera", "cam", 0)
    try:
        camera.set_output(False)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_series_window_includes_overlapping_chunks():
    ring = RingBuffer(cap_bytes=10_000_000)
    ring.append_joulescope(
        "joulescope:0",
        "js",
        1000,
        20_000_000,
        np.arange(20, dtype=np.float32),
        np.full(20, 3.3, dtype=np.float32),
        np.arange(20, dtype=np.float32),
    )
    # Window sits inside the chunk (t_end is 20ms, samples span 1–20ms).
    series = ring.joulescope_series("joulescope:0", 5_000_000, 8_000_000)
    assert series is not None
    assert len(series["t"]) >= 3
    assert series["t"][0] >= 5_000_000 - 1_000_000
    assert series["t"][-1] <= 8_000_000 + 1_000_000
    assert all(later >= earlier for earlier, later in zip(series["t"], series["t"][1:]))


def test_buckets_stable_when_panning():
    from measync.graph import SeriesBuckets

    ts = np.arange(0, 100_000, 100, dtype=np.int64)
    ys = np.sin(ts / 5000).astype(np.float64)
    a = SeriesBuckets(10_000, 50_000, max_points=40)
    b = SeriesBuckets(10_100, 50_100, max_points=40)
    a.add(ts, ys)
    b.add(ts, ys)
    left = a.finish()
    right = b.finish()
    overlap = [t for t in left["t"] if t in set(right["t"]) and 12_000 <= t <= 48_000]
    assert len(overlap) >= 20
    by_t = {t: m for t, m in zip(left["t"], left["mean"], strict=True)}
    right_by_t = {t: m for t, m in zip(right["t"], right["mean"], strict=True)}
    for t in overlap:
        assert right_by_t[t] == by_t[t]


def test_overlapping_chunk_times_stay_monotonic():
    ring = RingBuffer(cap_bytes=10_000_000)
    samples = np.linspace(0, 1, 40, dtype=np.float32)
    ring.append_audio("audio:0", "mic", 1000, 40_000_000, samples)
    ring.append_audio("audio:0", "mic", 1000, 45_000_000, samples)
    env = ring.audio_envelope("audio:0", 0, 50_000_000, max_points=200)
    assert env is not None and len(env["t"]) > 0
    assert all(later >= earlier for earlier, later in zip(env["t"], env["t"][1:]))


def test_raw_samples_stable_when_panning():
    ring = RingBuffer(cap_bytes=10_000_000)
    n = 200
    current = np.linspace(0, 0.2, n, dtype=np.float32)
    voltage = np.sin(np.arange(n) * 0.7).astype(np.float32)
    power = current * voltage
    ring.append_joulescope("joulescope:0", "js", 1000, 200_000_000, current, voltage, power)
    left = ring.joulescope_series("joulescope:0", 20_000_000, 80_000_000)
    right = ring.joulescope_series("joulescope:0", 20_500_000, 80_500_000)
    assert left is not None and right is not None
    assert left["raw"] is True
    assert right["raw"] is True
    assert left["t"] == left["t"]  # same clock for all channels
    assert len(left["t"]) == len(left["voltage"]["mean"]) == len(left["current"]["mean"])
    by_t = {
        t: (i, v)
        for t, i, v in zip(left["t"], left["current"]["mean"], left["voltage"]["mean"], strict=True)
    }
    overlap = 0
    for t, i, v in zip(right["t"], right["current"]["mean"], right["voltage"]["mean"], strict=True):
        if t not in by_t:
            continue
        overlap += 1
        assert i == by_t[t][0]
        assert v == by_t[t][1]
    assert overlap >= 50


def test_device_buffer_alias_does_not_rewrite_history():
    ring = RingBuffer(cap_bytes=10_000_000)
    current = np.full(8, 0.2, dtype=np.float32)
    voltage = np.full(8, 3.3, dtype=np.float32)
    power = current * voltage
    ring.append_joulescope("joulescope:0", "js", 1000, 8_000_000, current, voltage, power)
    current[:] = 0
    voltage[:] = 0
    power[:] = 0
    series = ring.joulescope_series("joulescope:0", 0, 8_000_000)
    assert series is not None
    assert series["current"]["mean"][0] == float(np.float32(0.2))
    assert series["voltage"]["mean"][0] == float(np.float32(3.3))

    pcm = np.linspace(-1, 1, 16, dtype=np.float32)
    ring.append_audio("audio:0", "mic", 8000, 8_000_000, pcm)
    pcm[:] = 0
    env = ring.audio_envelope("audio:0", 0, 8_000_000, max_points=200)
    assert env is not None
    assert max(abs(v) for v in env["mean"] if v is not None) > 0.5


def test_query_ring_stays_on_capture_take():
    from measync.session import Session

    dest = Path("/tmp/measync-test-query-ring")
    if dest.exists():
        import shutil

        shutil.rmtree(dest)
    session = Session(dest)
    session.store_audio("audio:0", "mic", 8000, 1_000_000_000, np.ones(8, dtype=np.float32))
    session.start_recording()
    session.stop_recording()
    session.live_ring.append_audio("audio:0", "ghost", 8000, 90_000_000_000, np.full(8, 7.0, dtype=np.float32))
    queried = session.query_ring(90_000_000_000, 91_000_000_000)
    assert queried is session.ring
    env = queried.audio_envelope("audio:0", 0, 2_000_000_000)
    assert env is not None
    assert env["mean"][0] == 1.0
    session.shutdown()


def test_live_seed_and_independent_eviction():
    from measync.session import LIVE_KEEP_NS, Session

    dest = Path("/tmp/measync-test-live-ring")
    if dest.exists():
        import shutil

        shutil.rmtree(dest)
    session = Session(dest)
    t0 = 10_000_000_000
    session.store_audio("audio:0", "mic", 8000, t0, np.ones(32, dtype=np.float32))
    assert session.dirty is False
    assert session.previewing() is True
    assert session.ring.range_ns() == (None, None)
    t_far_preview = t0 + LIVE_KEEP_NS + 5_000_000_000
    session.store_audio("audio:0", "mic", 8000, t_far_preview, np.ones(32, dtype=np.float32))
    live_min, live_max = session.live_ring.range_ns()
    assert live_min is not None and live_max is not None
    assert live_max == t_far_preview
    assert live_max - live_min <= LIVE_KEEP_NS + 1_000_000_000

    session.start_recording()
    assert session.recording is True
    assert session.dirty is True
    cap_min, cap_max = session.ring.range_ns()
    assert cap_min == live_min
    assert cap_max == live_max

    t1 = live_max + 2_000_000_000
    session.store_audio("audio:0", "mic", 8000, t1, np.ones(32, dtype=np.float32))
    assert session.ring.range_ns()[1] == t1
    assert session.live_ring.range_ns()[1] == live_max

    t_more = t1 + 1_000_000_000
    session.store_audio("audio:0", "mic", 8000, t_more, np.ones(32, dtype=np.float32))
    live_min2, live_max2 = session.live_ring.range_ns()
    assert live_max2 == live_max
    assert live_min2 == live_min
    cap_min2, cap_max2 = session.ring.range_ns()
    assert cap_min2 == cap_min
    assert cap_max2 == t_more

    session.stop_recording()
    assert session.recording is False
    t_stopped = t_more + 1_000_000_000
    session.store_audio("audio:0", "mic", 8000, t_stopped, np.ones(32, dtype=np.float32))
    assert session.ring.range_ns()[1] == t_more
    assert session.live_ring.range_ns()[1] == live_max

    session.start_recording()
    assert session.recording is True
    assert session.ring.range_ns()[0] == cap_min
    t_resume = t_more + 2_000_000_000
    session.store_audio("audio:0", "mic", 8000, t_resume, np.ones(32, dtype=np.float32))
    assert session.ring.range_ns()[1] == t_resume

    session.reset()
    assert session.recording is False
    assert session.dirty is False
    assert session.ring.range_ns() == (None, None)
    assert session.live_ring.range_ns() == (None, None)
    assert session.previewing() is True
    t_preview = t_resume + 1_000_000_000
    session.store_audio("audio:0", "mic", 8000, t_preview, np.ones(32, dtype=np.float32))
    assert session.ring.range_ns() == (None, None)
    assert session.live_ring.range_ns()[1] == t_preview
    session.shutdown()


if __name__ == "__main__":
    import shutil

    test_bucket_series_step_and_bands()
    test_sample_times_follow_instrument_rate()
    test_available_sample_span_skips_wrapped_ids()
    test_overlapping_joulescope_chunk_does_not_rewrite_history()
    test_evicts_oldest_time_aligned()
    dest = Path("/tmp/measync-test-captures")
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir()
    test_frame_and_waveform_and_roundtrip(dest)
    thermal_dest = dest / "thermal"
    thermal_dest.mkdir()
    test_thermal_decode_and_persist(thermal_dest)
    js_dest = dest / "joulescope"
    js_dest.mkdir()
    test_joulescope_series_persist(js_dest)
    test_livehub_offline_drops_latest()
    test_joulescope_output()
    test_series_window_includes_overlapping_chunks()
    test_buckets_stable_when_panning()
    test_overlapping_chunk_times_stay_monotonic()
    test_raw_samples_stable_when_panning()
    test_device_buffer_alias_does_not_rewrite_history()
    test_query_ring_stays_on_capture_take()
    test_live_seed_and_independent_eviction()
    print("ok")
