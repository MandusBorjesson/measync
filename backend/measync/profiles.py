from __future__ import annotations

import json
import re
from pathlib import Path

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(name: str) -> str:
    cleaned = _SAFE.sub("-", name.strip())[:80].strip(".-")
    if not cleaned:
        raise ValueError("invalid name")
    if cleaned in {".", ".."}:
        raise ValueError("invalid name")
    return cleaned


class ProfileStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[dict]:
        items = []
        for path in sorted(self.root.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            items.append({"name": data.get("name", path.stem), "path": path.name})
        return items

    def load(self, name: str) -> dict:
        path = self.root / f"{safe_name(name)}.json"
        if not path.exists():
            raise FileNotFoundError(name)
        return json.loads(path.read_text(encoding="utf-8"))

    def save(self, payload: dict) -> dict:
        name = safe_name(str(payload["name"]))
        payload = {**payload, "name": name}
        path = self.root / f"{name}.json"
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return payload

    def delete(self, name: str) -> None:
        path = self.root / f"{safe_name(name)}.json"
        if path.exists():
            path.unlink()
