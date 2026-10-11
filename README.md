# Local Data Inspector

A local-first SQL workbench for BigQuery users. **Query BigQuery once, then transform the result for free.**

- **Source nodes** bring data in and cache it locally as Parquet:
  - a **BigQuery query** (billed per run, guarded by dry-runs and a hard cap),
  - a **BigQuery table** read directly with the Storage Read API: pick columns and an optional row filter, no query job,
  - a **local file**: drop CSV, Parquet, Excel (.xlsx) or JSON on the canvas. It's copied into the workspace and read by DuckDB.
- **Transform nodes** run DuckDB SQL on cached inputs, locally and at no cost. Each connected input is a table named after its node: `SELECT * FROM orders JOIN customers USING (customer_id)`.
- Everything sits on a visual DAG. Nodes show row count, columns, execution time and when they last ran.
- **Chart nodes** (bar, line, scatter, pivot) take any node as input and draw its cached result locally.
- **Column profiles** (null %, distinct values, min/max, histograms) and a **run history** with run comparison sit under every result.
- **Parameters**: define `{{start_date}}` once and use it in Source and Transform SQL.
- A **BigQuery browser** (left) lists the billing project plus projects you pin in Settings, down to columns. Previewing a table's first rows is free. Drag a table onto the canvas to add it, or into a query.

Runs 100% on your machine (Windows and macOS). There's no server and no account; data never leaves your laptop except for the BigQuery queries you run.

## Setup (once)

Requirements: [uv](https://docs.astral.sh/uv/), Node 20+, and the [gcloud CLI](https://cloud.google.com/sdk/docs/install).

```bash
gcloud auth application-default login
npm --prefix frontend install
npm --prefix frontend run build
```

## Run

```bash
uv run --directory backend ldi
```

This opens http://127.0.0.1:8765. Then set your BigQuery billing project in **Settings** (top right). The top bar shows which Google account Application Default Credentials use; to switch, run `gcloud auth application-default login` again.

### Development (hot reload)

Windows: `./scripts/dev.ps1` · macOS: `./scripts/dev.sh`

This starts the API on :8765 with auto-reload and Vite on http://localhost:5173. To develop next to an `ldi` you keep open on :8765, run the API with `--port 8766` and start Vite with `LDI_API_PORT=8766`.

## How it works

| | |
|---|---|
| **Cost guard** | Source SQL is dry-run as you type, so you see bytes and $ before running. Above the confirm threshold (1 GiB by default) you're asked to confirm, and `maximum_bytes_billed` (50 GiB by default) is enforced by BigQuery on every run. |
| **Savings meter** | The top bar shows what you spent on BigQuery and what free local runs saved. Each BigQuery run is billed to the ledger; each transform run counts the bytes its upstream BigQuery sources processed as avoided (what re-querying would have cost). Per-node totals show on the card and the stats bar. History starts when this feature was added and survives node deletion. |
| **Warnings** | The dry run flags a missing filter on a partitioned table (1 GiB or larger), `SELECT *` on a table with more than 20 columns, and unusually large scans (5x the node's last run, or over half the safety cap). They are advice only: you confirm and run anyway. The checks are conservative, so a missed warning is more likely than a false one. |
| **Sample first** | BigQuery sources have a `Sample` control (1/5/10/25%). Table sources read a sample through the Storage API; query sources get `TABLESAMPLE SYSTEM (n PERCENT)` added to each fully written `project.dataset.table` (views, wildcard tables, CTEs and `FOR SYSTEM_TIME` are left alone). Sampled nodes and everything downstream are badged. **Run full** turns sampling off and runs the whole thing. |
| **Cache** | The disk icon in the top bar opens the cache manager: size per node, pin, delete one, or clean up all unpinned / stale / older than N days. A preview lists what goes and what BigQuery sources would cost to rebuild. Pinned caches are never cleaned. Deleting a cache sets the node back to *not run* and marks downstream stale. |
| **Profile** | The **Profile** tab under a result runs DuckDB `SUMMARIZE` on the cached Parquet: null %, approximate distinct count, min / max / average, a 20-bucket histogram for numbers and dates, and the top 5 values for text. Computed on demand and cached until the node re-runs. |
| **Charts** | Select a node and click **Chart**. Bar, line, scatter and pivot are aggregated by DuckDB over the input's Parquet, so only a few thousand points reach the browser (bars: top 30 categories plus *Other*; scatter: a 5,000-point sample). A chart has one input, nothing reads from it, and it is stale exactly when its input is. It never runs: it redraws when the input re-runs. |
| **Parameters** | Manage them from the `{}` button in the top bar (string, number, date, bool). In BigQuery sources `{{name}}` becomes a native typed query parameter (`@ldi_name`), so a value can't change the query; write `d >= {{start}}`, not `d >= '{{start}}'` (a bound parameter can't live inside quotes). In DuckDB transforms it becomes a quoted literal. Each run records the values its SQL used, so changing a parameter marks exactly the nodes that use it, and everything downstream, as stale. An undefined `{{name}}` fails the run with a clear message. Not supported in a table source's row filter. |
| **History** | Every successful run is recorded (SQL, settings, parameter values, rows, columns, time, bytes); the last 50 per node are kept. Pick two runs in the **History** tab to compare stats, schema, parameters and a line diff of the SQL. **Restore SQL** loads an old version into the editor. Result data of old runs is not kept, so there is no row-level diff. |
| **Refresh** | Sources only re-query BigQuery when you click **Refresh**. |
| **Staleness** | A node is *stale* when its SQL changed, or an input re-ran since it last ran. This propagates downstream. **Run downstream** re-runs every transform below a node in order and never touches BigQuery. |
| **Cancel** | **Cancel** on a running node cancels the BigQuery job or interrupts DuckDB and keeps the previous result. BigQuery cancels on a best-effort basis, so a job that is nearly done may still finish and be billed. |
| **Large results** | Results stream from the BigQuery Storage API straight to Parquet (falling back to the REST API if the Storage API is refused). The table pages and sorts server-side, so millions of rows stay fast. |
| **Export** | **Export** on any result: download CSV, Parquet or Excel, copy up to 10,000 rows to the clipboard (tab-separated, pastes into Excel or Sheets), or push it to a BigQuery table with a load job (create, overwrite or append). |
| **Rename** | Renaming a node rewrites `FROM old_name` in the transforms that read it (strings, comments and columns are left alone) and keeps their results fresh. |
| **Storage** | `%LOCALAPPDATA%\LocalDataInspector` (Windows) or `~/Library/Application Support/LocalDataInspector` (macOS): `workspace.sqlite`, `cache/<node>/*.parquet` and `files/` (dropped files). Override with `LDI_HOME`. |

Keyboard: `Ctrl/⌘ + Enter` runs the selected node. `Delete` removes the selected node or edge. Double-click a cell to copy it.

## Layout

```
backend/   FastAPI + DuckDB + BigQuery (Python, uv)
  ldi/engine/   dag.py (ordering, staleness) · executor.py · cancel.py · source_bq.py · source_file.py
                transform_duck.py · sqlrefs.py (rename rewriting) · sampling.py (TABLESAMPLE) · costwarn.py
                profile.py (SUMMARIZE) · chart.py (chart data) · params.py ({{params}}) · history.py (run comparison)
  ldi/cache/    Parquet store + paged reads
  ldi/api/      REST endpoints (cache.py: savings ledger, cache manager, pin; insight.py: profile, charts, history, params)
frontend/  React + TypeScript + Vite
  src/features/  canvas (React Flow) · explorer (BigQuery browser) · editor (CodeMirror + BigQuery autocomplete)
                 results (virtualized grid, export) · nodes · settings · charts (uPlot, SVG bars) · insight (profile, history) · params
```

Tests: `uv run --directory backend pytest`
