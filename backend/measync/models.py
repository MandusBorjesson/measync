from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Kind = Literal["camera", "audio", "thermal", "joulescope"]


class Device(BaseModel):
    id: str
    kind: Kind
    label: str
    index: int
    sample_rates: list[int] | None = None


class SourceInfo(BaseModel):
    id: str
    kind: Kind
    label: str
    sample_rate: int | None = None
    sample_rates: list[int] | None = None
    output_on: bool | None = None
    live: bool = True
    online: bool = True


class SessionStatus(BaseModel):
    recording: bool
    t_min: int | None
    t_max: int | None
    live_t_min: int | None = None
    live_t_max: int | None = None
    bytes_used: int
    bytes_cap: int
    dirty: bool
    sources: list[SourceInfo]


class CapUpdate(BaseModel):
    bytes_cap: int = Field(ge=1_000_000, le=64_000_000_000)


class RateUpdate(BaseModel):
    sample_rate: int = Field(ge=1, le=2_000_000)


class PortsUpdate(BaseModel):
    output_on: bool


class ProfilePayload(BaseModel):
    name: str
    layout: Any
    tiles: dict[str, Any]
    focused_id: str | None = None
    split_dir: Literal["h", "v"] = "v"


class CaptureName(BaseModel):
    name: str = Field(min_length=1, max_length=80)
