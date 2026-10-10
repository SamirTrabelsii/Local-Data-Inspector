from ldi.engine import dag


def test_topo_order_and_cycles():
    edges = [("a", "c"), ("b", "c"), ("c", "d")]
    assert dag.topo_order(["d", "c", "b", "a"], edges) == ["b", "a", "c", "d"]
    assert dag.would_cycle(edges, "d", "a")
    assert not dag.would_cycle(edges, "a", "d")
    assert dag.descendants(edges, "a") == {"c", "d"}


def test_staleness_propagates():
    nodes = [{"id": "s", "sql": "select 1"}, {"id": "t", "sql": "select * from s"}]
    edges = [("s", "t")]
    runs = {
        "s": {"sql_hash": dag.sql_hash("select 1"), "inputs": {}, "finished_at": "1"},
        "t": {"sql_hash": dag.sql_hash("select * from s"), "inputs": {"s": "1"}, "finished_at": "2"},
    }
    assert dag.compute_stale(nodes, edges, runs) == {"s": False, "t": False}

    runs["s"]["finished_at"] = "3"  # source refreshed
    assert dag.compute_stale(nodes, edges, runs) == {"s": False, "t": True}

    runs["s"]["finished_at"] = "1"
    nodes[0]["sql"] = "select 2"  # source edited, not re-run
    assert dag.compute_stale(nodes, edges, runs) == {"s": True, "t": True}
