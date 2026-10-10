import time

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LDI_HOME", str(tmp_path))
    from ldi.engine import source_bq
    from ldi.main import create_app

    def fake_bq(sql, settings, out):
        """Stand-in for BigQuery: the 'query' is ignored, a fixed table is returned."""
        table = pa.table({"id": [1, 2, 3, 4], "country": ["TN", "FR", "TN", "US"], "amount": [10.5, 20.0, 5.25, 7.0]})
        pq.write_table(table, out)
        return {"bytes_processed": 1234, "bytes_billed": 10485760}

    monkeypatch.setattr(source_bq, "run_to_parquet", fake_bq)
    with TestClient(create_app()) as c:
        yield c


def wait_idle(client, timeout=10.0):
    from ldi.engine.executor import executor

    deadline = time.time() + timeout
    while executor.running():
        assert time.time() < deadline, "run did not finish"
        time.sleep(0.02)
    return {n["name"]: n for n in client.get("/api/workspace").json()["nodes"]}
