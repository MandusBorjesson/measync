from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Kind = Literal["camera", "audio", "thermal"]


class Device(BaseModel):
    id: str
    kind: Kind
    label: str
    index: int


class SourceInfo(BaseModel):
    id: str
    kind: Kind
    label: str
    sample_rate: int | None = None
    live: bool = True


class SessionStatus(BaseModel):
    recording: bool
    t_min: int | None
    t_max: int | None
    bytes_used: int
    bytes_cap: int
    dirty: bool
    sources: list[SourceInfo]


class CapUpdate(BaseModel):
    bytes_cap: int = Field(ge=1_000_000, le=64_000_000_000)


class ProfilePayload(BaseModel):
    name: str
    layout: Any
    tiles: dict[str, Any]
    focused_id: str | None = None
    split_dir: Literal["h", "v"] = "v"


class CaptureName(BaseModel):
    name: str = Field(min_length=1, max_length=80)
