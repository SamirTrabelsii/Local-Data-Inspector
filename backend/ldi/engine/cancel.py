"""Cooperative cancellation for a run chain: a flag plus hooks that abort in-flight work."""

import logging
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager

log = logging.getLogger(__name__)


class Cancelled(Exception):
    def __init__(self) -> None:
        super().__init__("Cancelled")


class Token:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancelled = False
        self._hooks: list[Callable[[], None]] = []

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    def cancel(self) -> None:
        with self._lock:
            if self._cancelled:
                return
            self._cancelled = True
            hooks = list(self._hooks)
        for hook in hooks:
            try:
                hook()
            except Exception as exc:  # noqa: BLE001 - best effort: the flag is what stops the run
                log.info("Cancel hook failed: %s", exc)

    def check(self) -> None:
        if self._cancelled:
            raise Cancelled

    @contextmanager
    def on_cancel(self, hook: Callable[[], None]) -> Iterator[None]:
        """Call `hook` (from the cancelling thread) if the run is cancelled while inside this block."""
        with self._lock:
            already = self._cancelled
            if not already:
                self._hooks.append(hook)
        if already:
            hook()
        try:
            yield
        finally:
            with self._lock:
                if hook in self._hooks:
                    self._hooks.remove(hook)
