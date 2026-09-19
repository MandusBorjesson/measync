# AGENTS.md

This repository has a documented architecture. Treat it as binding, not background reading.

**Read [docs/architecture.md](docs/architecture.md) before changing session, capture, ring, presence, widgets, APIs, or persistence.** New code must fit that document. If a change would violate it, update `docs/architecture.md` in the same change (and [README.md](README.md) when user-facing behavior changes). Do not land architecture drift and “fix the docs later.”

## What this is

Lab workbench: tiled live sources, a short ~5 s preview ring plus one RAM capture ring, independent timeline per viewer. One backend process owns hardware and the rings; browsers are viewers of that single session. No auth, no multi-room.

## Widget families (required)

Widgets are built from two playback models. Most tiles use one; hybrid tiles compose both. Do not add a third scrub/playback model.

- **Real-time** (cameras today; text logs later) — closest **snapshot** to the selected timestamp (window centre).
- **Graph** (audio and Joulescope today) — render the **selected window**, centered on that timestamp. Zoomed in, those are the real samples; condensed windows use ingest-time 50 ms bins (sealed bins never change; only the open newest bin updates) folded to the viewer budget. This is the common path for every graph-style widget.
- **Hybrid** (Infiray thermals today) — snapshot on top, selected-window graph below. Same two query types, one tile; the graph pane uses the same ingest-time bins.

Live camera/thermal **images** still use `/ws/live/{source_id}` while the buffer is growing and lock front is on. Graph tiles always render the selected window via HTTP range queries. Wheel-zoom / drag-pan on graphs and the timeline share [`frontend/src/viewport.ts`](frontend/src/viewport.ts) (lock front / lock back). After Stop, Play/Pause is the same playhead, advanced locally — not a third scrub model.

## Boundaries

- [`backend/measync/main.py`](backend/measync/main.py) — HTTP/WebSocket routes only.
- [`backend/measync/session.py`](backend/measync/session.py) — orchestrates recording, sources, `dirty`, capture `ring` and preview `live_ring`.
- [`backend/measync/capture.py`](backend/measync/capture.py) — daemon threads; live-publish while the device is open; retry after disconnect; `store_*` routes samples to preview or capture.
- [`backend/measync/ring.py`](backend/measync/ring.py) — time-aligned global eviction; optional `keep_ns` for the live ring; monotonic nanoseconds.
- [`frontend/src/layout.ts`](frontend/src/layout.ts) — mosaic tree math; do not fork a second layout model.
- [`frontend/src/viewport.ts`](frontend/src/viewport.ts) — viewer window math (lock/zoom/pan); do not fork a second scrub model.
- [`backend/measync/models.py`](backend/measync/models.py) and [`frontend/src/types.ts`](frontend/src/types.ts) stay aligned.

## Invariants (short)

One session, one monotonic-ns time base, one global byte cap with **time-aligned** eviction on the capture ring, a ~5 s time-capped `live_ring` in preview. Record copies the live ring when the capture is empty, otherwise resumes. Stop writes neither ring. Reset clears RAM and returns to preview. No save/open while recording. Source IDs `{kind}:{index}` (`camera:0`, `thermal:2`, `audio:1`, `joulescope:0` today). Layout last-write-wins on the presence hub.

Details and API tables: [docs/architecture.md](docs/architecture.md).

## How to run

See [README.md](README.md). After ring or persist changes: `python -m measync.selftest` from an environment with the backend installed.
