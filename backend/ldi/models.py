"""Request bodies. Responses are plain dicts built in workspace.py."""

from typing import Literal

from pydantic import BaseModel, Field


class NodeCreate(BaseModel):
    kind: Literal["source", "transform", "chart"]
    # File sources are created by uploading the file (POST /api/files), not here.
    source_type: Literal["bq_query", "bq_table"] = "bq_query"
    name: str | None = None
    name_hint: str | None = None  # derive a free name from this (e.g. a table id) when `name` is empty
    sql: str = ""
    config: dict = {}
    x: float = 0
    y: float = 0
    inputs: list[str] = []


class NodeUpdate(BaseModel):
    name: str | None = None
    sql: str | None = None
    config: dict | None = None
    x: float | None = None
    y: float | None = None


class PushRequest(BaseModel):
    table: str
    mode: Literal["create", "overwrite", "append"] = "create"


class EdgeCreate(BaseModel):
    source: str
    target: str


class DryRunRequest(BaseModel):
    sql: str
    sample_percent: float | None = Field(default=None, gt=0, lt=100)
    node_id: str | None = None  # lets the dry run compare against this node's previous scan


class PinRequest(BaseModel):
    pinned: bool


class CleanRequest(BaseModel):
    scope: Literal["unpinned", "stale", "older_than"] = "unpinned"
    older_than_days: int = Field(default=30, ge=0)
    preview: bool = False  # only report what would be removed


class Settings(BaseModel):
    bq_project: str = ""
    bq_location: str = ""
    max_bytes_billed: int = Field(gt=0)
    confirm_above_bytes: int = Field(ge=0)
    price_per_tib_usd: float = Field(ge=0)
    bq_pinned_projects: list[str] = []
