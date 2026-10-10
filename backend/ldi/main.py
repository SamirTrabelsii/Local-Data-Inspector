import argparse
import threading
import webbrowser
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, config, db, repo
from .api import bigquery, nodes, results
from .engine.executor import Busy


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="Local Data Inspector", version=__version__, lifespan=lifespan)

    @app.exception_handler(repo.NotFound)
    async def _not_found(_: Request, exc: Exception):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(repo.Invalid)
    async def _invalid(_: Request, exc: Exception):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(Busy)
    async def _busy(_: Request, exc: Exception):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    for module in (nodes, results, bigquery):
        app.include_router(module.router)

    dist = config.frontend_dist()
    if dist.exists():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    return app


app = create_app()


def cli() -> None:
    parser = argparse.ArgumentParser(prog="ldi", description="Local Data Inspector")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--reload", action="store_true", help="dev: auto-reload on code changes")
    args = parser.parse_args()

    import uvicorn

    url = f"http://127.0.0.1:{args.port}"
    if not args.no_browser and config.frontend_dist().exists():
        threading.Timer(1.0, webbrowser.open, (url,)).start()
    print(f"Local Data Inspector -> {url}  (data: {config.data_dir()})")
    uvicorn.run("ldi.main:app", host="127.0.0.1", port=args.port, reload=args.reload)
