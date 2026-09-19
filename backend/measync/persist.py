from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from measync.profiles import safe_name
from measync.ring import AudioTrack, CamTrack, JoulescopeTrack, RingBuffer


def list_captures(root: Path) -> list[dict]:
    root.mkdir(parents=True, exist_ok=True)
    items = []
    for path in sorted(p for p in root.iterdir() if p.is_dir()):
        meta_path = path / "session.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        items.append(
            {
                "name": meta.get("name", path.name),
                "t_min": meta.get("t_min"),
                "t_max": meta.get("t_max"),
                "bytes": meta.get("bytes_used"),
                "sources": meta.get("sources", []),
            }
        )
    return items


def _source_dir(root: Path, source_id: str) -> Path:
    return root / source_id.replace(":", "_")


def save_capture(ring: RingBuffer, dest_root: Path, name: str) -> dict:
    dest = dest_root / safe_name(name)
    if dest.exists():
        raise FileExistsError(name)
    dest.mkdir(parents=True)

    cameras, audios, scopes, _used = ring.copy_tracks()
    t_min, t_max, used, cap = ring.snapshot_status()
    sources: list[dict] = []

    for sid, track in cameras.items():
        if not len(track):
            continue
        folder = _source_dir(dest, sid)
        folder.mkdir()
        ts = np.array(track.t[track.start :], dtype=np.int64)
        sizes = np.array([len(j) for j in track.jpeg[track.start :]], dtype=np.uint32)
        np.save(folder / "timestamps.npy", ts)
        np.save(folder / "sizes.npy", sizes)
        with (folder / "frames.bin").open("wb") as fh:
            for jpeg in track.jpeg[track.start :]:
                fh.write(jpeg)
        sources.append({"id": sid, "kind": track.kind, "label": track.label})

    for sid, track in audios.items():
        if not len(track):
            continue
        folder = _source_dir(dest, sid)
        folder.mkdir()
        ts = np.array(track.t[track.start :], dtype=np.int64)
        pmin = np.array(track.pmin[track.start :], dtype=np.float32)
        pmax = np.array(track.pmax[track.start :], dtype=np.float32)
        lengths = np.array([len(c) for c in track.pcm[track.start :]], dtype=np.int32)
        pcm = np.concatenate(track.pcm[track.start :]) if lengths.size else np.zeros(0, dtype=np.float32)
        np.savez(
            folder / "audio.npz",
            t=ts,
            pmin=pmin,
            pmax=pmax,
            lengths=lengths,
            pcm=pcm,
            sample_rate=np.int32(track.sample_rate),
        )
        sources.append(
            {
                "id": sid,
                "kind": "audio",
                "label": track.label,
                "sample_rate": track.sample_rate,
            }
        )

    for sid, track in scopes.items():
        if not len(track):
            continue
        folder = _source_dir(dest, sid)
        folder.mkdir()
        ts = np.array(track.t[track.start :], dtype=np.int64)
        rates = np.array(track.rates[track.start :], dtype=np.int32)
        lengths = np.array([len(c) for c in track.current[track.start :]], dtype=np.int32)
        current = (
            np.concatenate(track.current[track.start :]) if lengths.size else np.zeros(0, dtype=np.float32)
        )
        voltage = (
            np.concatenate(track.voltage[track.start :]) if lengths.size else np.zeros(0, dtype=np.float32)
        )
        power = np.concatenate(track.power[track.start :]) if lengths.size else np.zeros(0, dtype=np.float32)
        np.savez(
            folder / "series.npz",
            t=ts,
            rates=rates,
            lengths=lengths,
            current=current,
            voltage=voltage,
            power=power,
            sample_rate=np.int32(track.sample_rate),
        )
        sources.append(
            {
                "id": sid,
                "kind": "joulescope",
                "label": track.label,
                "sample_rate": track.sample_rate,
            }
        )

    meta = {
        "name": safe_name(name),
        "t_min": t_min,
        "t_max": t_max,
        "bytes_used": used,
        "bytes_cap": cap,
        "sources": sources,
    }
    (dest / "session.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def load_capture(ring: RingBuffer, dest_root: Path, name: str) -> dict:
    dest = dest_root / safe_name(name)
    meta_path = dest / "session.json"
    if not meta_path.exists():
        raise FileNotFoundError(name)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    cameras: dict[str, CamTrack] = {}
    audios: dict[str, AudioTrack] = {}
    scopes: dict[str, JoulescopeTrack] = {}
    used = 0

    for src in meta.get("sources", []):
        sid = src["id"]
        folder = _source_dir(dest, sid)
        kind = src["kind"]
        if kind in {"camera", "thermal"}:
            ts = np.load(folder / "timestamps.npy")
            sizes = np.load(folder / "sizes.npy")
            blob = (folder / "frames.bin").read_bytes()
            track = CamTrack(label=src.get("label") or sid, kind=kind)
            offset = 0
            for t_ns, size in zip(ts.tolist(), sizes.tolist(), strict=True):
                jpeg = blob[offset : offset + int(size)]
                offset += int(size)
                used += track.append(int(t_ns), jpeg)
            cameras[sid] = track
        elif kind == "audio":
            data = np.load(folder / "audio.npz")
            rate = int(data["sample_rate"])
            track = AudioTrack(label=src.get("label") or sid, sample_rate=rate)
            pcm = data["pcm"]
            lengths = data["lengths"]
            ts = data["t"]
            cursor = 0
            for t_ns, length in zip(ts.tolist(), lengths.tolist(), strict=True):
                chunk = np.ascontiguousarray(pcm[cursor : cursor + int(length)], dtype=np.float32)
                cursor += int(length)
                used += track.append(int(t_ns), chunk)
            audios[sid] = track
        elif kind == "joulescope":
            data = np.load(folder / "series.npz")
            rate = int(data["sample_rate"])
            track = JoulescopeTrack(label=src.get("label") or sid, sample_rate=rate)
            current = data["current"]
            voltage = data["voltage"]
            power = data["power"]
            lengths = data["lengths"]
            ts = data["t"]
            rates = data["rates"] if "rates" in data.files else np.full(len(ts), rate, dtype=np.int32)
            cursor = 0
            for t_ns, length, chunk_rate in zip(ts.tolist(), lengths.tolist(), rates.tolist(), strict=True):
                n = int(length)
                used += track.append(
                    int(t_ns),
                    np.ascontiguousarray(current[cursor : cursor + n], dtype=np.float32),
                    np.ascontiguousarray(voltage[cursor : cursor + n], dtype=np.float32),
                    np.ascontiguousarray(power[cursor : cursor + n], dtype=np.float32),
                    int(chunk_rate),
                )
                cursor += n
            scopes[sid] = track

    if used > ring.cap_bytes:
        raise MemoryError(
            f"capture is {used} bytes, larger than the {ring.cap_bytes} byte cap; raise the cap and retry"
        )
    ring.replace_from(cameras, audios, used, scopes)
    return meta
