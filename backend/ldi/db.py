"""SQLite workspace: nodes, edges, last run per node, errors, settings."""

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('source', 'transform')),
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sql        TEXT NOT NULL DEFAULT '',
    source_type TEXT,                      -- sources only: bq_query | bq_table | file
    config     TEXT NOT NULL DEFAULT '{}', -- json, per source_type (table to read, uploaded file...)
    pos_x      REAL NOT NULL DEFAULT 0,
    pos_y      REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
    source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (source, target)
);
-- Last successful run per node; its Parquet file is the node's cached output.
CREATE TABLE IF NOT EXISTS runs (
    node_id         TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    sql_hash        TEXT NOT NULL,
    inputs          TEXT NOT NULL,  -- json {input_node_id: input finished_at} at run time
    cache_file      TEXT NOT NULL,
    row_count       INTEGER NOT NULL,
    columns         TEXT NOT NULL,  -- json [{name, type}]
    exec_ms         INTEGER NOT NULL,
    bytes_processed INTEGER,
    bytes_billed    INTEGER,
    finished_at     TEXT NOT NULL
);
-- Last failed attempt; cleared on the next success.
CREATE TABLE IF NOT EXISTS errors (
    node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

GIB = 1024**3

DEFAULT_SETTINGS: dict = {
    "bq_project": "",  # empty = ADC / gcloud default project
    "bq_location": "",  # empty = let BigQuery infer
    "max_bytes_billed": 50 * GIB,  # hard cap enforced by BigQuery on every Source run
    "confirm_above_bytes": 1 * GIB,  # UI asks for confirmation above this estimate
    "price_per_tib_usd": 6.25,  # on-demand price used for estimates
    "bq_pinned_projects": [],  # extra projects shown in the schema browser (e.g. bigquery-public-data)
}

# Columns added after the first release, applied to existing workspaces on startup.
MIGRATIONS = [
    ("nodes", "source_type", "ALTER TABLE nodes ADD COLUMN source_type TEXT"),
    ("nodes", "config", "ALTER TABLE nodes ADD COLUMN config TEXT NOT NULL DEFAULT '{}'"),
]


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    con = sqlite3.connect(config.db_path(), timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        with con:
            yield con
    finally:
        con.close()


def init() -> None:
    with connect() as con:
        con.execute("PRAGMA journal_mode = WAL")
        con.executescript(SCHEMA)
        for table, column, ddl in MIGRATIONS:
            if column not in {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}:
                con.execute(ddl)
        con.execute("UPDATE nodes SET source_type = 'bq_query' WHERE kind = 'source' AND source_type IS NULL")


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def get_settings() -> dict:
    with connect() as con:
        rows = con.execute("SELECT key, value FROM settings").fetchall()
    settings = dict(DEFAULT_SETTINGS)
    settings.update({r["key"]: json.loads(r["value"]) for r in rows if r["key"] in DEFAULT_SETTINGS})
    return settings


def save_settings(values: dict) -> dict:
    with connect() as con:
        for key, value in values.items():
            if key in DEFAULT_SETTINGS:
                con.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    (key, json.dumps(value)),
                )
    return get_settings()
