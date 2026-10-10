"""Filesystem locations. Everything lives in the per-user data dir (override with LDI_HOME)."""

import os
from pathlib import Path

from platformdirs import user_data_dir

APP_NAME = "LocalDataInspector"


def data_dir() -> Path:
    root = Path(os.environ.get("LDI_HOME") or user_data_dir(APP_NAME, appauthor=False))
    root.mkdir(parents=True, exist_ok=True)
    return root


def cache_dir() -> Path:
    d = data_dir() / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def duckdb_tmp_dir() -> Path:
    d = data_dir() / "duckdb_tmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return data_dir() / "workspace.sqlite"


def frontend_dist() -> Path:
    return Path(__file__).resolve().parents[2] / "frontend" / "dist"
