# AGENTS.md

This repository has a documented architecture. Treat it as binding, not background reading.

**Read [docs/architecture.md](docs/architecture.md) before changing session, capture, ring, presence, widgets, APIs, or persistence.** New code must fit that document. If a change would violate it, update `docs/architecture.md` in the same change (and [README.md](README.md) when user-facing behavior changes). Do not land architecture drift and “fix the docs later.”

## What this is

Lab workbench: tiled live sources, one shared RAM capture ring, independent timeline per viewer. One backend process owns hardware and the ring; browsers are viewers of that single session. No auth, no multi-room.

## Widget families (required)

Widgets are built from two playback models. Most tiles use one; hybrid tiles compose both. Do not add a third scrub/playback model.

- **Real-time** (cameras today; text logs later) — closest **snapshot** to the selected timestamp (window centre).
- **Graph** (audio today; current/voltage later) — render the **selected window**, centered on that timestamp.
- **Hybrid** (Infiray thermals today) — snapshot on top, selected-window graph below. Same two query types, one tile.

Live preview still uses `/ws/live/{source_id}`. Scrub/playback uses HTTP ring queries (point query vs range query).

## Boundaries

- [`backend/measync/main.py`](backend/measync/main.py) — HTTP/WebSocket routes only.
- [`backend/measync/session.py`](backend/measync/session.py) — orchestrates recording, sources, `dirty`.
- [`backend/measync/capture.py`](backend/measync/capture.py) — daemon threads; live-publish while the device is open; retry after disconnect; append to the ring only while recording.
- [`backend/measync/ring.py`](backend/measync/ring.py) — time-aligned global eviction; monotonic nanoseconds.
- [`frontend/src/layout.ts`](frontend/src/layout.ts) — mosaic tree math; do not fork a second layout model.
- [`backend/measync/models.py`](backend/measync/models.py) and [`frontend/src/types.ts`](frontend/src/types.ts) stay aligned.

## Invariants (short)

One session, one monotonic-ns time base, one global byte cap with **time-aligned** eviction. Record **clears** the ring. No save/open while recording. Source IDs `{kind}:{index}` (`camera:0`, `thermal:2`, `audio:1` today). Layout last-write-wins on the presence hub.

Details and API tables: [docs/architecture.md](docs/architecture.md).

## How to run

See [README.md](README.md). After ring or persist changes: `python -m measync.selftest` from an environment with the backend installed.
