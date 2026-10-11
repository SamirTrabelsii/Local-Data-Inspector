"""BigQuery: Source runs (query or direct table read), schema browsing, free previews, pushing results back.

Query runs cost money, so they are guarded by dry-runs and `maximum_bytes_billed`.
"""

import concurrent.futures
import json
import logging
import time
import urllib.request
import warnings
from collections.abc import Callable, Iterable, Iterator
from functools import lru_cache
from pathlib import Path

import google.auth
import google.auth.transport.requests
import pyarrow as pa
import pyarrow.parquet as pq
from google.api_core import exceptions as gexc
from google.cloud import bigquery, bigquery_storage
from google.cloud.bigquery_storage import types as bqs_types

from ..cache.store import to_json
from . import costwarn, sampling
from .cancel import Token

log = logging.getLogger(__name__)

TIB = 1024**4
TABLE_ID_PARTS = 3
POLL_SECONDS = 1.0

# Personal use with `gcloud auth application-default login` is the intended setup; don't nag on every call.
warnings.filterwarnings("ignore", message="Your application has authenticated using end user credentials")


@lru_cache(maxsize=4)
def _client(project: str, location: str) -> bigquery.Client:
    return bigquery.Client(project=project or None, location=location or None)


@lru_cache(maxsize=4)
def _storage_client(project: str) -> bigquery_storage.BigQueryReadClient:
    # User credentials from `gcloud auth application-default login` carry no quota project, and the
    # Storage API refuses those calls. Bill them to the same project as the query jobs.
    return bigquery_storage.BigQueryReadClient(client_options={"quota_project_id": project} if project else None)


def client(settings: dict) -> bigquery.Client:
    return _client(settings["bq_project"], settings["bq_location"])


def storage_client(settings: dict) -> bigquery_storage.BigQueryReadClient:
    return _storage_client(client(settings).project or "")


def error_message(exc: BaseException) -> str:
    errors = getattr(exc, "errors", None)
    if errors and isinstance(errors[0], dict) and errors[0].get("message"):
        return errors[0]["message"]
    return getattr(exc, "message", None) or str(exc) or type(exc).__name__


def _account_email(creds) -> str | None:
    email = getattr(creds, "service_account_email", None)
    if email:
        return email
    try:  # user credentials don't expose their email; ask Google which account the token belongs to
        url = "https://oauth2.googleapis.com/tokeninfo?access_token=" + creds.token
        with urllib.request.urlopen(url, timeout=5) as resp:
            return json.load(resp).get("email")
    except Exception:  # noqa: BLE001 - the email is informative only
        return None


def auth_status(settings: dict) -> dict:
    try:
        creds, default_project = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(google.auth.transport.requests.Request())
    except Exception as exc:  # noqa: BLE001 - surface any auth failure to the UI
        return {
            "ok": False,
            "project": settings["bq_project"] or None,
            "account": None,
            "error": str(exc),
            "hint": "Run: gcloud auth application-default login",
        }
    project = settings["bq_project"] or default_project
    return {
        "ok": True,
        "project": project,
        "account": _account_email(creds),
        "error": None,
        "hint": None if project else "Set a BigQuery project in Settings",
    }


_FACTS_TTL = 300
_facts_cache: dict[str, tuple[float, dict]] = {}


def _table_facts(settings: dict, ref: bigquery.TableReference) -> dict:
    """Size, width and partitioning of a table, cached for a few minutes (dry runs fire while you type)."""
    key = f"{ref.project}.{ref.dataset_id}.{ref.table_id}"
    hit = _facts_cache.get(key)
    if hit and time.monotonic() - hit[0] < _FACTS_TTL:
        return hit[1]
    t = client(settings).get_table(ref)
    field = None
    if t.time_partitioning:
        field = t.time_partitioning.field or "_PARTITIONTIME"
    elif t.range_partitioning:
        field = t.range_partitioning.field
    facts = {"id": key, "num_bytes": t.num_bytes, "num_columns": len(t.schema), "partition_field": field}
    _facts_cache[key] = (time.monotonic(), facts)
    return facts


def effective_sql(sql: str, sample_percent: float | None) -> str:
    """The SQL BigQuery actually receives: with TABLESAMPLE added when the source runs in sample mode."""
    if not sample_percent:
        return sql
    sampled, count = sampling.sample_sql(sql, sample_percent)
    if count == 0:
        raise ValueError(
            "Sample mode found no table to sample. Write tables as project.dataset.table "
            "(views and wildcard tables can't be sampled), or turn sample mode off."
        )
    return sampled


def dry_run(sql: str, settings: dict, sample_percent: float | None = None, previous_bytes: int | None = None) -> dict:
    run_sql = effective_sql(sql, sample_percent)
    cfg = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
    job = client(settings).query(run_sql, job_config=cfg)
    processed = job.total_bytes_processed or 0
    try:
        tables = [_table_facts(settings, ref) for ref in (job.referenced_tables or [])[:8]]
        found = costwarn.analyze(sql, tables, processed, previous_bytes, settings)
    except Exception as exc:  # noqa: BLE001 - warnings are a bonus; never fail the estimate over them
        log.info("Could not analyze the query for warnings: %s", exc)
        found = []
    return {
        "bytes_processed": processed,
        "estimated_cost_usd": processed / TIB * settings["price_per_tib_usd"],
        "max_bytes_billed": settings["max_bytes_billed"],
        "needs_confirm": processed > settings["confirm_above_bytes"],
        "exceeds_cap": processed > settings["max_bytes_billed"],
        "sample_percent": sample_percent or None,
        "warnings": found,
    }


# ---- writing ----------------------------------------------------------------


def write_batches(batches: Iterable[pa.RecordBatch], out: Path, empty_schema: Callable[[], pa.Schema], token: Token) -> None:
    """Stream record batches into one Parquet file; a result with no batches still gets its schema."""
    tmp = out.with_suffix(".tmp")
    writer: pq.ParquetWriter | None = None
    schema: pa.Schema | None = None
    try:
        for batch in batches:
            token.check()
            if writer is None:
                schema = batch.schema
                writer = pq.ParquetWriter(tmp, schema, compression="zstd")
            elif batch.schema != schema:
                batch = batch.cast(schema)
            writer.write_batch(batch)
    finally:
        if writer is not None:
            writer.close()
    token.check()
    if writer is None:
        pq.write_table(empty_schema().empty_table(), tmp, compression="zstd")
    tmp.replace(out)


# ---- Source: query ----------------------------------------------------------


def _wait(job: bigquery.QueryJob, token: Token) -> None:
    while True:
        token.check()
        try:
            job.result(timeout=POLL_SECONDS)
            return
        except concurrent.futures.TimeoutError:
            continue
        except Exception:
            token.check()  # a job cancelled under us fails; report it as a cancel, not an error
            raise


def _cancel_job(job: bigquery.QueryJob) -> None:
    try:
        job.cancel()
    except Exception as exc:  # noqa: BLE001 - the job may already be done
        log.info("Could not cancel job %s: %s", job.job_id, exc)


def _result_batches(job: bigquery.QueryJob, settings: dict) -> Iterator[pa.RecordBatch]:
    """Arrow batches of a finished job: Storage API for large results, REST if the Storage API is refused."""
    batches = job.result().to_arrow_iterable(bqstorage_client=storage_client(settings))
    try:
        first = next(batches, None)
    except (gexc.PermissionDenied, gexc.Forbidden, gexc.Unauthenticated) as exc:
        log.warning("BigQuery Storage API unavailable (%s); downloading over REST instead", error_message(exc))
        batches = job.result().to_arrow_iterable()
        first = next(batches, None)
    if first is not None:
        yield first
        yield from batches


def run_to_parquet(sql: str, settings: dict, out: Path, token: Token | None = None) -> dict:
    """Execute with a hard bytes-billed cap; stream Arrow batches to disk. Cancel kills the BigQuery job."""
    token = token or Token()
    token.check()
    cfg = bigquery.QueryJobConfig(maximum_bytes_billed=int(settings["max_bytes_billed"]))
    job = client(settings).query(sql, job_config=cfg)
    with token.on_cancel(lambda: _cancel_job(job)):
        _wait(job, token)
        write_batches(
            _result_batches(job, settings),
            out,
            lambda: job.result().to_arrow(create_bqstorage_client=False).schema,
            token,
        )
    return {"bytes_processed": job.total_bytes_processed, "bytes_billed": job.total_bytes_billed}


# ---- Source: direct table read (Storage Read API, no query job) ------------


def parse_table_id(table_id: str) -> tuple[str, str, str]:
    parts = table_id.strip().strip("`").replace(":", ".").split(".")
    if len(parts) != TABLE_ID_PARTS or not all(parts):
        raise ValueError(f"'{table_id}' is not a full table id: use project.dataset.table")
    return parts[0], parts[1], parts[2]


READABLE_TYPES = {"TABLE", "SNAPSHOT", "EXTERNAL"}


def read_table_to_parquet(config: dict, settings: dict, out: Path, token: Token | None = None) -> dict:
    """Copy a table (optionally some columns / a row filter) through the Storage Read API.

    No query job runs, so nothing is billed as analysis; Storage API reads have their own (large) free tier.
    """
    token = token or Token()
    project, dataset, table = parse_table_id(config.get("table", ""))
    info = client(settings).get_table(f"{project}.{dataset}.{table}")
    if info.table_type not in READABLE_TYPES:
        raise ValueError(f"{info.table_type.lower()}s can't be read directly - use a query source instead")
    storage = storage_client(settings)
    requested = bqs_types.ReadSession(
        table=f"projects/{project}/datasets/{dataset}/tables/{table}",
        data_format=bqs_types.DataFormat.ARROW,
        read_options=bqs_types.ReadSession.TableReadOptions(
            selected_fields=list(config.get("columns") or []),
            row_restriction=(config.get("row_filter") or "").strip(),
            sample_percentage=config.get("sample_percent") or None,
        ),
    )
    session = storage.create_read_session(
        parent=f"projects/{client(settings).project}", read_session=requested, max_stream_count=1
    )
    schema = pa.ipc.read_schema(pa.py_buffer(session.arrow_schema.serialized_schema))

    def batches() -> Iterator[pa.RecordBatch]:
        for stream in session.streams:
            for page in storage.read_rows(stream.name).rows(session).pages:
                yield page.to_arrow()

    write_batches(batches(), out, lambda: schema, token)
    return {"bytes_processed": session.estimated_total_bytes_scanned or None, "bytes_billed": None}


# ---- schema browser and free preview ----------------------------------------


def list_datasets(settings: dict, project: str) -> list[dict]:
    return [
        {"id": d.dataset_id, "location": d._properties.get("location")}
        for d in client(settings).list_datasets(project=project)
    ]


def list_tables(settings: dict, project: str, dataset: str) -> list[dict]:
    return [
        {"id": t.table_id, "type": t.table_type}
        for t in client(settings).list_tables(bigquery.DatasetReference(project, dataset))
    ]


def _field(f: bigquery.SchemaField) -> dict:
    out = {"name": f.name, "type": f.field_type, "mode": f.mode, "description": f.description}
    if f.fields:
        out["fields"] = [_field(x) for x in f.fields]
    return out


def describe_table(settings: dict, table_id: str) -> dict:
    t = client(settings).get_table(".".join(parse_table_id(table_id)))
    part = t.time_partitioning
    return {
        "id": f"{t.project}.{t.dataset_id}.{t.table_id}",
        "type": t.table_type,
        "num_rows": t.num_rows,
        "num_bytes": t.num_bytes,
        "location": t.location,
        "created": t.created.isoformat() if t.created else None,
        "modified": t.modified.isoformat() if t.modified else None,
        "description": t.description,
        "partitioning": None if part is None else {"type": part.type_, "field": part.field},
        "clustering": t.clustering_fields,
        "columns": [_field(f) for f in t.schema],
    }


def preview(settings: dict, table_id: str, limit: int) -> dict:
    """First rows via tabledata.list: free, no query job, no Storage API."""
    rows = client(settings).list_rows(".".join(parse_table_id(table_id)), max_results=limit)
    arrow = rows.to_arrow(create_bqstorage_client=False)
    return {
        "columns": [{"name": f.name, "type": f.field_type} for f in rows.schema],
        "rows": [[to_json(v) for v in r.values()] for r in arrow.to_pylist()],
    }


# ---- push a result back -------------------------------------------------------

WRITE_MODES = {
    "create": bigquery.WriteDisposition.WRITE_EMPTY,
    "overwrite": bigquery.WriteDisposition.WRITE_TRUNCATE,
    "append": bigquery.WriteDisposition.WRITE_APPEND,
}


def push_parquet(path: Path, table_id: str, mode: str, settings: dict) -> dict:
    """Load a cached Parquet result into a BigQuery table. Load jobs are free."""
    target = ".".join(parse_table_id(table_id))
    cfg = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.PARQUET,
        write_disposition=WRITE_MODES[mode],
        create_disposition=bigquery.CreateDisposition.CREATE_IF_NEEDED,
    )
    opts = bigquery.ParquetOptions()
    opts.enable_list_inference = True
    cfg.parquet_options = opts
    with path.open("rb") as f:
        job = client(settings).load_table_from_file(f, target, job_config=cfg)
    job.result()
    return {"table": target, "rows": job.output_rows}

