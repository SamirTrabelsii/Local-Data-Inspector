"""Request bodies. Responses are plain dicts built in workspace.py."""

from typing import Literal

from pydantic import BaseModel, Field


class NodeCreate(BaseModel):
    kind: Literal["source", "transform"]
    name: str | None = None
    sql: str = ""
    x: float = 0
    y: float = 0
    inputs: list[str] = []


class NodeUpdate(BaseModel):
    name: str | None = None
    sql: str | None = None
    x: float | None = None
    y: float | None = None


class EdgeCreate(BaseModel):
    source: str
    target: str


class DryRunRequest(BaseModel):
    sql: str


class Settings(BaseModel):
    bq_project: str = ""
    bq_location: str = ""
    max_bytes_billed: int = Field(gt=0)
    confirm_above_bytes: int = Field(ge=0)
    price_per_tib_usd: float = Field(ge=0)
