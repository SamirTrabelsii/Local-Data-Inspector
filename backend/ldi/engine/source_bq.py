"""Source nodes: run BigQuery SQL once, stream the result to Parquet. Costs money, so guarded."""

import warnings
from functools import lru_cache
from pathlib import Path

import google.auth
import google.auth.transport.requests
import pyarrow.parquet as pq
from google.cloud import bigquery, bigquery_storage

TIB = 1024**4

# Personal use with `gcloud auth application-default login` is the intended setup; don't nag on every call.
warnings.filterwarnings("ignore", message="Your application has authenticated using end user credentials")


@lru_cache(maxsize=4)
def _client(project: str, location: str) -> bigquery.Client:
    return bigquery.Client(project=project or None, location=location or None)


@lru_cache(maxsize=1)
def _storage_client() -> bigquery_storage.BigQueryReadClient:
    return bigquery_storage.BigQueryReadClient()


def client(settings: dict) -> bigquery.Client:
    return _client(settings["bq_project"], settings["bq_location"])


def error_message(exc: Exception) -> str:
    errors = getattr(exc, "errors", None)
    if errors and isinstance(errors[0], dict) and errors[0].get("message"):
        return errors[0]["message"]
    return getattr(exc, "message", None) or str(exc) or type(exc).__name__


def auth_status(settings: dict) -> dict:
    try:
        creds, default_project = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(google.auth.transport.requests.Request())
    except Exception as exc:  # noqa: BLE001 - surface any auth failure to the UI
        return {
            "ok": False,
            "project": settings["bq_project"] or None,
            "error": str(exc),
            "hint": "Run: gcloud auth application-default login",
        }
    return {
        "ok": True,
        "project": settings["bq_project"] or default_project,
        "account": getattr(creds, "service_account_email", None),
        "error": None,
        "hint": None if (settings["bq_project"] or default_project) else "Set a BigQuery project in Settings",
    }


def dry_run(sql: str, settings: dict) -> dict:
    cfg = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)
    job = client(settings).query(sql, job_config=cfg)
    processed = job.total_bytes_processed or 0
    return {
        "bytes_processed": processed,
        "estimated_cost_usd": processed / TIB * settings["price_per_tib_usd"],
        "max_bytes_billed": settings["max_bytes_billed"],
        "needs_confirm": processed > settings["confirm_above_bytes"],
        "exceeds_cap": processed > settings["max_bytes_billed"],
    }


def run_to_parquet(sql: str, settings: dict, out: Path) -> dict:
    """Execute with a hard bytes-billed cap; stream Arrow batches to disk (Storage API for large results)."""
    cfg = bigquery.QueryJobConfig(maximum_bytes_billed=int(settings["max_bytes_billed"]))
    job = client(settings).query(sql, job_config=cfg)
    rows = job.result()
    tmp = out.with_suffix(".tmp")
    writer: pq.ParquetWriter | None = None
    try:
        for batch in rows.to_arrow_iterable(bqstorage_client=_storage_client()):
            if writer is None:
                writer = pq.ParquetWriter(tmp, batch.schema, compression="zstd")
            elif batch.schema != writer.schema_arrow:
                batch = batch.cast(writer.schema_arrow)
            writer.write_batch(batch)
    finally:
        if writer is not None:
            writer.close()
    if writer is None:  # zero rows: still write the schema
        pq.write_table(job.result().to_arrow(create_bqstorage_client=False), tmp, compression="zstd")
    tmp.replace(out)
    return {"bytes_processed": job.total_bytes_processed, "bytes_billed": job.total_bytes_billed}
