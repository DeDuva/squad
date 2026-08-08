"""The Inspect solver wrapper (Task 1.4).

Wraps a solver so that what the agent does is recorded as it happens: outbound
model calls, tool executions, and the filesystem deltas they cause.

``inspect_ai`` is an optional extra, and it is imported lazily. Analysis and
verification of an already-recorded experiment must not require the recorder's
dependencies to resolve — someone checking a published manifest should not need
the harness stack installed to do it.

**This adapter has not been exercised against a real Inspect installation.**
``inspect-ai`` could not be installed in the environment this was built in, so
what is verified is the recording logic against a fake solver with the same
shape. The seam is deliberately thin for that reason: everything that could be
wrong about ADP, batching, sequencing, or resume lives in :class:`Recorder` and
is tested there and against a live ADP. What is unverified here is the shape of
Inspect's own types, which is the part a first real run will find immediately
and cheaply.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from adp_replay.recording.recorder import Recorder
from adp_replay.storage.capture import Capture, CaptureOptions, capture_tree


class Solver(Protocol):
    """The shape this wrapper needs, named so it can be faked in tests.

    Inspect's own solver signature is `(state, generate) -> state`. Depending on
    the protocol rather than the import is what keeps this module importable
    without the harness installed.
    """

    async def __call__(self, state: Any, generate: Any) -> Any: ...


@dataclass(frozen=True)
class StateDelta:
    """What one step did to the filesystem."""

    before: str
    after: str

    @property
    def changed(self) -> bool:
        return self.before != self.after


class RecordingSolver:
    """A solver that records what the one it wraps does.

    Every hook here is `record` — a local spool append that returns immediately.
    A tool call must never block on an ADP write, so nothing in this class
    waits on the network, and the flush thread deals with everything else.
    """

    def __init__(
        self,
        inner: Solver,
        recorder: Recorder,
        *,
        workspace: Path | None = None,
        capture_options: CaptureOptions | None = None,
        model: str | None = None,
    ) -> None:
        self._inner = inner
        self._recorder = recorder
        self._workspace = workspace
        self._capture_options = capture_options
        self._model = model
        self._last_capture: Capture | None = None

    async def __call__(self, state: Any, generate: Any) -> Any:
        self._recorder.record(
            "custom",
            type="solver_start",
            payload={"model": self._model},
        )
        try:
            result = await self._inner(state, self._wrap_generate(generate))
        except Exception as error:
            self._recorder.record(
                "custom",
                type="solver_error",
                status="error",
                payload={"error": repr(error)},
            )
            raise
        self._recorder.record("custom", type="solver_end", status="success", payload={})
        return result

    def _wrap_generate(self, generate: Any) -> Callable[..., Any]:
        """Record each outbound model call around the real one."""

        async def recording_generate(*args: Any, **kwargs: Any) -> Any:
            self._recorder.record(
                "model_call",
                model=self._model,
                payload={"args": len(args)},
            )
            return await generate(*args, **kwargs)

        return recording_generate

    # --- tool execution and state deltas --------------------------------------

    def record_tool_call(self, name: str, arguments: Any, call_id: str | None = None) -> int:
        return self._recorder.record(
            "tool_call",
            payload={"name": name, "arguments": arguments, "id": call_id},
        )

    def record_tool_result(
        self, call_id: str | None, content: Any, *, is_error: bool = False
    ) -> int:
        return self._recorder.record(
            "tool_call",
            type="tool_result",
            status="failure" if is_error else "success",
            payload={"call_id": call_id, "content": content},
        )

    def capture_delta(self) -> StateDelta | None:
        """Snapshot the workspace and record what moved since the last snapshot.

        Returns None when no workspace was given, because a recorder without one
        is recording a trajectory and not a filesystem — which is a legitimate
        configuration, and better than pretending to a completeness it does not
        have.
        """
        if self._workspace is None:
            return None

        capture = capture_tree(self._workspace, self._capture_options)
        before = self._last_capture.digest if self._last_capture else capture.digest
        self._last_capture = capture

        delta = StateDelta(before=before, after=capture.digest)
        self._recorder.record(
            "custom",
            type="state_delta",
            payload={
                "before": delta.before,
                "after": delta.after,
                "changed": delta.changed,
                # A tree holding a socket is not fully captured by v0, and the
                # event says so rather than leaving a manifest to overstate it.
                "filesystem_complete": capture.is_complete_for_filesystem,
                "skipped": list(capture.skipped),
            },
        )
        return delta


def inspect_solver(recorder: Recorder, **kwargs: Any) -> Callable[[Solver], RecordingSolver]:
    """Decorator form, for wrapping an Inspect solver at its definition."""

    def wrap(inner: Solver) -> RecordingSolver:
        return RecordingSolver(inner, recorder, **kwargs)

    return wrap
