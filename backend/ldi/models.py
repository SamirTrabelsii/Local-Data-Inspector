"""Request bodies. Responses are plain dicts built in workspace.py."""

from typing import Literal

from pydantic import BaseModel, Field


class NodeCreate(BaseModel):
    kind: Literal["source", "transform"]
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


class Settings(BaseModel):
    bq_project: str = ""
    bq_location: str = ""
    max_bytes_billed: int = Field(gt=0)
    confirm_above_bytes: int = Field(ge=0)
    price_per_tib_usd: float = Field(ge=0)
    bq_pinned_projects: list[str] = []
