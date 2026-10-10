"""File sources: the browser streams a dropped file here; it is copied into the workspace and becomes a node."""

import re
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Request

from .. import config, repo
from ..engine import source_file
from ..engine.executor import Busy, executor

router = APIRouter(prefix="/api")


async def _save_upload(request: Request, filename: str) -> dict:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", Path(filename).name).strip() or "file"
    try:
        fmt = source_file.detect_format(name)
    except ValueError as exc:
        raise repo.Invalid(str(exc)) from None
    folder = config.files_dir() / uuid.uuid4().hex[:12]
    folder.mkdir()
    dest = folder / name
    try:
        with dest.open("wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        cfg = {"file": f"{folder.name}/{name}", "name": name, "format": fmt, "size": dest.stat().st_size}
        if fmt == "excel":
            cfg["sheets"] = source_file.excel_sheets(dest)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return cfg


def _remove(cfg: dict) -> None:
    if cfg.get("file"):
        shutil.rmtree(source_file.file_path(cfg).parent, ignore_errors=True)


@router.post("/files", status_code=201)
async def upload_file(request: Request, filename: str, x: float = 0, y: float = 0) -> dict:
    """Body: the raw file bytes. Creates a file source named after the file."""
    cfg = await _save_upload(request, filename)
    try:
        return repo.create_node(
            "source", None, "", x, y, [], source_type="file", config=cfg, name_hint=Path(cfg["name"]).stem
        )
    except Exception:
        _remove(cfg)
        raise


@router.put("/nodes/{node_id}/file")
async def replace_file(node_id: str, request: Request, filename: str) -> dict:
    node = repo.get_node(node_id)
    if node["source_type"] != "file":
        raise repo.Invalid("Only file sources have a file")
    if node_id in executor.running():
        raise Busy("Can't replace the file while the node is running")
    cfg = await _save_upload(request, filename)
    repo.set_config(node_id, cfg)
    _remove(node["config"])
    return repo.get_node(node_id)
