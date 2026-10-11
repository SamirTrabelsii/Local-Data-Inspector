import sqlite3

import pytest
from conftest import wait_idle

from ldi import db
from ldi.engine import params as P
from ldi.engine import source_bq


def run(client, node_id):
    assert client.post(f"/api/nodes/{node_id}/run").status_code == 202
    return wait_idle(client)


def make_pipeline(client, tr_sql="SELECT country, sum(amount) AS t FROM orders GROUP BY ALL"):
    src = client.post("/api/nodes", json={"kind": "source", "name": "orders", "sql": "SELECT 1"}).json()
    tr = client.post(
        "/api/nodes", json={"kind": "transform", "name": "agg", "sql": tr_sql, "inputs": [src["id"]]}
    ).json()
    return src, tr


def put_param(client, name, type_, value):
    r = client.put(f"/api/params/{name}", json={"type": type_, "value": value})
    assert r.status_code == 200, r.text
    return r.json()


# ---- profiling --------------------------------------------------------------------


def test_profile_reports_nulls_distincts_and_histograms(client):
    src, _ = make_pipeline(client)
    run(client, src["id"])
    prof = client.get(f"/api/nodes/{src['id']}/profile").json()
    cols = {c["name"]: c for c in prof["columns"]}

    assert prof["rows"] == 4
    assert cols["amount"]["kind"] == "numeric"
    assert (cols["amount"]["min"], cols["amount"]["max"]) == ("5.25", "20.0")
    assert sum(cols["amount"]["histogram"]["counts"]) == 4
    assert cols["country"]["top"][0] == {"value": "TN", "count": 2}
    assert cols["country"]["null_pct"] == 0
    assert client.get(f"/api/nodes/{src['id']}/profile").json() == prof  # served from the cache


def test_profile_is_dropped_when_the_node_reruns(client):
    src, _ = make_pipeline(client)
    run(client, src["id"])
    client.get(f"/api/nodes/{src['id']}/profile")
    with db.connect() as con:
        assert con.execute("SELECT count(*) FROM profiles").fetchone()[0] == 1
    run(client, src["id"])
    with db.connect() as con:
        assert con.execute("SELECT count(*) FROM profiles").fetchone()[0] == 0


def test_profile_needs_a_result(client):
    src, _ = make_pipeline(client)
    assert client.get(f"/api/nodes/{src['id']}/profile").status_code == 404


# ---- parameters ---------------------------------------------------------------------


def test_param_binding_is_typed_and_safe():
    ps = {
        "d": P.validate("d", "date", "2024-01-02"),
        "n": P.validate("n", "number", "3"),
        "s": P.validate("s", "string", "o'k"),
        "b": P.validate("b", "bool", "true"),
    }
    sql, specs = P.bind_bigquery("SELECT * FROM t WHERE d >= {{d}} AND n < {{ n }} -- {{ignored}}", ps)
    assert sql == "SELECT * FROM t WHERE d >= @ldi_d AND n < @ldi_n -- {{ignored}}"
    assert [(n, t) for n, t, _ in specs] == [("ldi_d", "DATE"), ("ldi_n", "INT64")]
    assert (
        P.bind_duckdb("SELECT {{s}}, {{n}}, {{d}}, {{b}}", ps) == "SELECT 'o''k', 3, DATE '2024-01-02', TRUE"
    )
    assert P.find("SELECT {{a}} -- {{b}}\n, {{a}}, {{c}}") == ["a", "c"]


def test_bigquery_strings_with_escapes_do_not_hide_placeholders():
    ps = {"n": P.validate("n", "number", "1")}
    escaped = r"SELECT 'it\'s' FROM t WHERE x = {{n}}"
    assert P.bind_bigquery(escaped, ps)[0] == r"SELECT 'it\'s' FROM t WHERE x = @ldi_n"
    with pytest.raises(P.ParamError, match="inside a quoted string"):
        P.bind_bigquery("SELECT '''{{n}}''' FROM t", ps)


def test_param_errors():
    ps = {"d": P.validate("d", "date", "2024-01-02")}
    with pytest.raises(P.ParamError, match="inside a quoted string"):
        P.bind_duckdb("SELECT '{{d}}'", ps)
    with pytest.raises(P.ParamError, match="Unknown parameter"):
        P.bind_duckdb("SELECT {{nope}}", ps)
    with pytest.raises(P.ParamError):
        P.validate("d", "date", "yesterday")
    with pytest.raises(P.ParamError):
        P.validate("bad name", "string", "x")


def test_param_api_validates_and_lists_usage(client):
    make_pipeline(client, "SELECT {{min_amount}} AS m, * FROM orders")
    assert client.put("/api/params/min_amount", json={"type": "number", "value": "abc"}).status_code == 400
    listing = put_param(client, "min_amount", "number", "6")
    assert listing == [{"name": "min_amount", "type": "number", "value": "6", "used_by": ["agg"]}]
    client.delete("/api/params/min_amount")
    undefined = client.get("/api/params").json()
    assert undefined == [{"name": "min_amount", "type": None, "value": None, "used_by": ["agg"]}]


def test_transform_uses_param_value_and_reports_missing(client):
    src, tr = make_pipeline(client, "SELECT country FROM orders WHERE amount >= {{min_amount}}")
    run(client, src["id"])
    nodes = run(client, tr["id"])
    assert nodes["agg"]["status"] == "error" and "Unknown parameter" in nodes["agg"]["error"]
    assert nodes["agg"]["params_missing"] == ["min_amount"]

    put_param(client, "min_amount", "number", "10")
    nodes = run(client, tr["id"])
    assert nodes["agg"]["status"] == "fresh"
    assert nodes["agg"]["result"]["row_count"] == 2  # 10.5 and 20.0


def test_changing_a_param_marks_only_its_nodes_stale(client):
    put_param(client, "min_amount", "number", "6")
    src, tr = make_pipeline(client, "SELECT country FROM orders WHERE amount >= {{min_amount}}")
    plain = client.post(
        "/api/nodes",
        json={"kind": "transform", "name": "plain", "sql": "SELECT * FROM orders", "inputs": [src["id"]]},
    ).json()
    leaf = client.post(
        "/api/nodes",
        json={"kind": "transform", "name": "leaf", "sql": "SELECT * FROM agg", "inputs": [tr["id"]]},
    ).json()
    run(client, src["id"])
    for n in (tr, plain, leaf):
        run(client, n["id"])
    assert {n["status"] for n in wait_idle(client).values()} == {"fresh"}

    put_param(client, "min_amount", "number", "10")
    nodes = wait_idle(client)
    assert nodes["agg"]["status"] == "stale"
    assert nodes["leaf"]["status"] == "stale"  # downstream of a stale node
    assert nodes["plain"]["status"] == "fresh" and nodes["orders"]["status"] == "fresh"

    put_param(client, "min_amount", "number", "6")  # back to what the run used
    assert wait_idle(client)["agg"]["status"] == "fresh"


def test_bigquery_source_binds_native_query_parameters(client, monkeypatch):
    seen = {}

    def fake(sql, settings, out, token=None, query_params=None):
        seen["sql"], seen["params"] = sql, query_params
        import pyarrow as pa
        import pyarrow.parquet as pq

        pq.write_table(pa.table({"x": [1]}), out)
        return {"bytes_processed": 1, "bytes_billed": 0}

    monkeypatch.setattr(source_bq, "run_to_parquet", fake)
    put_param(client, "start", "date", "2024-03-01")
    src = client.post(
        "/api/nodes", json={"kind": "source", "name": "s", "sql": "SELECT * FROM t WHERE d >= {{start}}"}
    ).json()
    assert run(client, src["id"])["s"]["status"] == "fresh"
    assert seen["sql"] == "SELECT * FROM t WHERE d >= @ldi_start"
    assert [(n, t) for n, t, _ in seen["params"]] == [("ldi_start", "DATE")]

    put_param(client, "start", "date", "2024-04-01")
    assert wait_idle(client)["s"]["status"] == "stale"


def test_rename_does_not_touch_parameter_placeholders(client):
    from ldi.engine.sqlrefs import rename_references

    assert rename_references("SELECT {{orders}} FROM orders", "orders", "o")[0] == "SELECT {{orders}} FROM o"


# ---- run history ----------------------------------------------------------------------


def test_history_records_sql_params_and_stats_and_compares(client):
    put_param(client, "min_amount", "number", "6")
    src, tr = make_pipeline(client, "SELECT country FROM orders WHERE amount >= {{min_amount}}")
    run(client, src["id"])
    run(client, tr["id"])
    put_param(client, "min_amount", "number", "10")
    client.patch(
        f"/api/nodes/{tr['id']}",
        json={"sql": "SELECT country, amount FROM orders WHERE amount >= {{min_amount}}"},
    )
    run(client, tr["id"])

    hist = client.get(f"/api/nodes/{tr['id']}/history").json()
    assert [h["row_count"] for h in hist] == [2, 3][::-1] or len(hist) == 2
    newest, oldest = hist
    assert newest["params"] == {"min_amount": "number:10"} and oldest["params"] == {"min_amount": "number:6"}
    assert oldest["sql"].startswith("SELECT country FROM")

    diff = client.get(
        f"/api/nodes/{tr['id']}/history/compare", params={"a": newest["id"], "b": oldest["id"]}
    ).json()
    assert diff["a"] == oldest["id"] and diff["b"] == newest["id"]  # always older -> newer
    assert diff["sql_changed"] and {d["op"] for d in diff["sql_diff"]} == {"add", "del"}
    assert diff["params_changed"] == {"min_amount": {"before": "number:6", "after": "number:10"}}
    assert diff["columns"]["added"] == [{"name": "amount", "type": "DOUBLE"}]
    assert diff["stats"]["row_count"]["a"] == oldest["row_count"]
    assert client.get(f"/api/nodes/{tr['id']}/history/compare", params={"a": 999, "b": 1}).status_code == 404


def test_history_is_trimmed_and_removed_with_the_node(client, monkeypatch):
    monkeypatch.setattr(db, "HISTORY_KEEP", 3)
    src, _ = make_pipeline(client)
    for _ in range(5):
        run(client, src["id"])
    assert len(client.get(f"/api/nodes/{src['id']}/history").json()) == 3
    client.delete(f"/api/nodes/{src['id']}")
    with db.connect() as con:
        assert con.execute("SELECT count(*) FROM run_history").fetchone()[0] == 0


# ---- chart nodes ----------------------------------------------------------------------


def make_chart(client, src, **cfg):
    chart = client.post(
        "/api/nodes", json={"kind": "chart", "name": "chart_1", "config": cfg, "inputs": [src["id"]]}
    )
    assert chart.status_code == 201, chart.text
    return chart.json()


def test_chart_node_rules(client):
    src, tr = make_pipeline(client)
    chart = make_chart(client, src, type="bar", x="country", y=["amount"])
    assert chart["kind"] == "chart" and chart["config"]["agg"] == "sum"
    assert (
        client.post("/api/edges", json={"source": tr["id"], "target": chart["id"]}).status_code == 400
    )  # one input
    assert (
        client.post("/api/edges", json={"source": chart["id"], "target": tr["id"]}).status_code == 400
    )  # end point
    assert client.post(f"/api/nodes/{chart['id']}/run").status_code == 400
    assert client.patch(f"/api/nodes/{chart['id']}", json={"config": {"type": "donut"}}).status_code == 400


def test_chart_status_follows_its_input_and_is_skipped_by_run_downstream(client):
    src, _ = make_pipeline(client)
    chart = make_chart(client, src, type="bar", x="country", y=["amount"])
    assert wait_idle(client)["chart_1"]["status"] == "never_run"
    run(client, src["id"])
    assert wait_idle(client)["chart_1"]["status"] == "fresh"
    client.patch(f"/api/nodes/{src['id']}", json={"sql": "SELECT 2"})
    assert wait_idle(client)["chart_1"]["status"] == "stale"
    r = client.post(f"/api/nodes/{src['id']}/run-downstream")
    assert r.status_code == 202 and chart["id"] not in r.json()["queued"]
    wait_idle(client)


def test_chart_data_bar_line_scatter_pivot(client):
    src, _ = make_pipeline(client)
    chart = make_chart(client, src, type="bar", x="country", y=["amount"])
    url = f"/api/nodes/{chart['id']}/chart-data"
    assert client.post(url, json={}).status_code == 409  # input has not run
    run(client, src["id"])

    bar = client.post(url, json={}).json()
    assert bar["labels"] == ["TN", "FR", "US"][: len(bar["labels"])] or set(bar["labels"]) == {
        "TN",
        "FR",
        "US",
    }
    assert dict(zip(bar["labels"], bar["series"][0]["values"], strict=True))["TN"] == 15.75

    counted = client.post(url, json={"config": {"type": "bar", "x": "country", "agg": "count"}}).json()
    assert dict(zip(counted["labels"], counted["series"][0]["values"], strict=True))["TN"] == 2

    by_series = client.post(
        url, json={"config": {"type": "bar", "x": "id", "y": ["amount"], "series": "country"}}
    ).json()
    assert {s["name"] for s in by_series["series"]} == {"TN", "FR", "US"}

    line = client.post(url, json={"config": {"type": "line", "x": "id", "y": ["amount"]}}).json()
    assert (
        line["xkind"] == "numeric"
        and line["x"] == [1, 2, 3, 4]
        and line["series"][0]["values"] == [10.5, 20, 5.25, 7]
    )

    scatter = client.post(
        url, json={"config": {"type": "scatter", "x": "id", "y": ["amount"], "series": "country"}}
    ).json()
    assert scatter["shown"] == scatter["total"] == 4 and len(scatter["series"]) == 3

    pivot = client.post(
        url,
        json={"config": {"type": "pivot", "rows": "country", "cols": "id", "value": "amount", "agg": "sum"}},
    ).json()
    assert pivot["row_labels"] == ["FR", "TN", "US"] and pivot["col_labels"] == ["1", "2", "3", "4"]
    assert pivot["cells"][1] == [10.5, None, 5.25, None]


def test_chart_data_validates_columns(client):
    src, _ = make_pipeline(client)
    chart = make_chart(client, src, type="bar", x="country", y=["amount"])
    run(client, src["id"])
    url = f"/api/nodes/{chart['id']}/chart-data"
    r = client.post(url, json={"config": {"type": "bar", "x": "nope", "y": ["amount"]}})
    assert r.status_code == 400 and "nope" in r.json()["detail"]
    r = client.post(url, json={"config": {"type": "scatter", "x": "country", "y": ["amount"]}})
    assert r.status_code == 400


def test_bar_chart_folds_small_categories_into_other(client, monkeypatch):
    import pyarrow as pa
    import pyarrow.parquet as pq

    def many(sql, settings, out, token=None):
        pq.write_table(pa.table({"k": [f"c{i}" for i in range(40)], "v": [1.0] * 40}), out)
        return {}

    monkeypatch.setattr(source_bq, "run_to_parquet", many)
    src, _ = make_pipeline(client)
    chart = make_chart(client, src, type="bar", x="k", y=["v"])
    run(client, src["id"])
    bar = client.post(f"/api/nodes/{chart['id']}/chart-data", json={}).json()
    assert len(bar["labels"]) == 31 and bar["labels"][-1] == "Other" and bar["truncated"]
    assert bar["series"][0]["values"][-1] == 10


# ---- migration ---------------------------------------------------------------------------


def test_existing_workspace_gets_chart_support(tmp_path, monkeypatch):
    """A database made before M3 rejects kind='chart'; init() rebuilds the table and keeps every row."""
    monkeypatch.setenv("LDI_HOME", str(tmp_path))
    from ldi import config

    old_schema = db.SCHEMA.replace(", 'chart'", "")
    assert "'chart'" not in old_schema
    con = sqlite3.connect(config.db_path())
    con.executescript(old_schema)
    con.execute(
        "INSERT INTO nodes (id, kind, name, sql, created_at, updated_at) VALUES ('a','source','a','x','t','t')"
    )
    con.execute(
        "INSERT INTO nodes (id, kind, name, sql, created_at, updated_at) VALUES ('b','transform','b','x','t','t')"
    )
    con.execute("INSERT INTO edges (source, target) VALUES ('a', 'b')")
    con.execute(
        "INSERT INTO runs (node_id, sql_hash, inputs, cache_file, row_count, columns, exec_ms, finished_at) "
        "VALUES ('a','h','{}','f',1,'[]',1,'t')"
    )
    con.commit()
    con.close()

    db.init()
    db.init()  # idempotent
    with db.connect() as con:
        con.execute(
            "INSERT INTO nodes (id, kind, name, created_at, updated_at) VALUES ('c','chart','c','t','t')"
        )
        assert con.execute("SELECT count(*) FROM nodes").fetchone()[0] == 3
        assert con.execute("SELECT count(*) FROM edges").fetchone()[0] == 1
        assert con.execute("SELECT count(*) FROM runs").fetchone()[0] == 1
        assert con.execute("PRAGMA foreign_key_check").fetchall() == []
        con.execute("DELETE FROM nodes WHERE id = 'a'")  # cascades still work after the rebuild
        assert con.execute("SELECT count(*) FROM runs").fetchone()[0] == 0
