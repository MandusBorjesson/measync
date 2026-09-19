# measync

Tiled measurement sync: live sources, a shared RAM capture buffer, and a timeline every viewer can scrub independently.

Tiles are **real-time** widgets (closest snapshot at the selected time — cameras today, text logs later), **graph** widgets (the selected window, centered on that time — audio today, current/voltage traces later), or **hybrid** widgets that compose both in one tile (Infiray thermals: live feed on top, temperature graph below).

System shape, APIs, and invariants: [docs/architecture.md](docs/architecture.md).

## Requirements

- Python 3.11+
- Node.js 20+
- Linux video devices (`/dev/video*`)
- Microphones need PortAudio: `sudo apt install libportaudio2`

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ./backend

cd frontend && npm install && cd ..
```

## Run

Terminal 1 — API:

```bash
source .venv/bin/activate
uvicorn measync.main:app --app-dir backend --host 127.0.0.1 --port 8000 --reload
```

Terminal 2 — UI:

```bash
cd frontend && npm run dev
```

Open http://127.0.0.1:5173 and enter a display name.

## Use

1. **Add source** — pick a camera, Infiray thermal, or mic. The first tile fills the workspace; later sources split the focused pane (or use a tile’s split buttons). Drag a tile header onto another tile to swap, or onto an edge to dock. Layout is shared with every connected viewer.
2. **Record / Stop** — capture into a capped RAM ring. Oldest samples drop (time-aligned across sources) when the cap is reached. Click the RAM meter to change the cap.
3. **Timeline** — live by default. Click to scrub, scroll to zoom the window. Real-time tiles (camera) show the closest snapshot at the window centre; graph tiles (audio) show the selected window centered on that timestamp; hybrid tiles (thermal) do both, and you can drag zones on the feed for local min/max traces.
4. **Captures** — after Stop, save the ring to `data/captures/` or open a previous take back into RAM.
5. **Profiles** — save/load this browser’s tile layout and sources (`data/profiles/`).
6. Open a second browser: markers on the timeline show other viewers. Click a name to jump to their window.

Unsaved RAM captures are discarded when you Record again or stop the backend.
