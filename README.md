# measync

Tiled measurement sync: live sources, a shared RAM capture buffer, and a timeline every viewer can scrub independently.

Tiles are **real-time** widgets (closest snapshot at the selected time — cameras today, text logs later), **graph** widgets (the selected window, centered on that time — audio amplitude and Joulescope U/I/P; condensed windows draw a mean line plus a min/max band), or **hybrid** widgets that compose both in one tile (Infiray thermals: live feed on top, temperature graph below).

System shape, APIs, and invariants: [docs/architecture.md](docs/architecture.md).

## Requirements

- Python 3.11+
- Node.js 20+
- Linux video devices (`/dev/video*`)
- Microphones need PortAudio: `sudo apt install libportaudio2`
- Joulescopes need the `joulescope` Python package (installed with the backend) and USB access

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

1. **Add source** — pick a camera, Infiray thermal, mic, or Joulescope. The first tile fills the workspace; later sources split the focused pane (or use a tile’s split buttons). Drag a tile header onto another tile to swap, or onto an edge to dock. Layout is shared with every connected viewer. Unplug a device and the live tile goes black (`OFFLINE`); plug it back in and capture resumes. Joulescope tiles stack current / voltage / power; use the I/V/P buttons to hide a pane and the rate control to set the instrument output sample rate. **out** opens or closes the current port (powers or unpowers a series-wired DUT).
2. **Record / Stop** — one toggle. First Record copies the last ~5 s of preview into the capture ring, then keeps appending. Record after Stop resumes the same take. Oldest capture samples drop (time-aligned across sources) when the RAM cap is reached. Click the RAM meter to change the cap. **Reset** discards RAM (confirm if unsaved) and returns to the 5 s preview.
3. **Lock back / Lock front** — pin the window to the oldest or newest samples. Both on (default) fits the full buffer. Scroll to zoom; drag the timeline or a graph to pan (turns locks off). **plot** in the header sets how many points each graph draws (default 100; stored in this browser). Real-time tiles (camera) show the closest snapshot at the window centre, or a live image while the buffer is growing and lock front is on; graph tiles (audio, Joulescope) always show the selected window (mean line, min/max band when samples collapse); hybrid tiles (thermal) do both, and you can drag zones on the feed for local min/max traces.
4. **Captures** — after Stop, save the ring to `data/captures/` or open a previous take back into RAM.
5. **Profiles** — save/load this browser’s tile layout and sources (`data/profiles/`).
6. Open a second browser: markers on the timeline show other viewers. Click a name to jump to their window.

Unsaved RAM captures are discarded when you Reset (after confirm) or stop the backend. Record from preview keeps the live tail you were just watching at the start of the new take.
