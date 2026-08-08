"""Local spool backing the recorder (Task 1.4).

The recorder never blocks a tool call on an ADP write: steps are spooled locally
and flushed asynchronously in batches. That is a correctness property as much as
a performance one — the G1 budget is 10% wall-clock overhead inclusive of ADP
round-trips, and a synchronous append puts network latency on the agent's
critical path.

Resume protocol, which is what makes a killed recorder recoverable:

* append batches carrying ``producer_seq`` and ``client_event_id``
* on a 409 contiguity rejection, replay from the returned ``expected_next_seq``
* trim the spool at ``accepted_through``
* treat a non-zero ``duplicates`` count as a bug signal, not as normal traffic

On disk, under the spool root:

``events.jsonl``
    One event per line, in sequence order. Append-only between trims, which is
    what makes a kill survivable: the line is on the OS's side of the boundary
    before ``record`` returns.

``state.json``
    The producer id and ``accepted_through``. Rewritten only on a trim.

**What a kill costs, precisely.** Lines are written and flushed out of the
process, so a killed *process* loses nothing. They are not fsynced, so a killed
*machine* can lose recent events. That is a deliberate trade against the G1
budget: an fsync per event would put a disk round-trip on the agent's critical
path to buy durability against a failure mode this experiment does not run into.
``fsync=True`` buys it back where the trade is wrong. Either way ADP's emitter
counter makes the loss visible rather than silent — a gap is what ``emitters_ok``
reports on.
"""

from __future__ import annotations

import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any

EVENTS = "events.jsonl"
STATE = "state.json"


class SpoolCorrupt(RuntimeError):
    """The spool on disk is not something the resume protocol can continue."""


class Spool:
    """Durable local queue of events awaiting acknowledgement from ADP."""

    def __init__(self, root: Path, *, producer_id: str | None = None, fsync: bool = False) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._fsync = fsync

        state = self._load_state()
        if state is None:
            # A fresh spool. The producer id is minted once and kept, because it
            # is the identity ADP counts against: a restart that invented a new
            # one would look like a second emitter on the same session.
            self._producer_id = producer_id or f"adp-replay-{uuid.uuid4().hex[:12]}"
            self._accepted_through = 0
            self._write_state()
        else:
            self._producer_id = str(state["producer_id"])
            self._accepted_through = int(state["accepted_through"])
            if producer_id is not None and producer_id != self._producer_id:
                raise SpoolCorrupt(
                    f"this spool belongs to producer {self._producer_id!r}, not "
                    f"{producer_id!r}; resuming under a different identity would "
                    "restart the count ADP checks for completeness"
                )

        self._next_seq = max(self._accepted_through, self._last_seq_on_disk()) + 1

    # --- identity and marks ---------------------------------------------------

    @property
    def producer_id(self) -> str:
        return self._producer_id

    @property
    def next_seq(self) -> int:
        return self._next_seq

    @property
    def accepted_through(self) -> int:
        return self._accepted_through

    @property
    def depth(self) -> int:
        """How many events are spooled and not yet acknowledged."""
        return len(self.pending())

    # --- the protocol ---------------------------------------------------------

    def append(self, event: dict[str, Any]) -> int:
        """Record an event locally and return its ``producer_seq``.

        ``client_event_id`` is derived from the producer id and the sequence
        number rather than randomly generated, so a replayed event carries the
        same id it did the first time and ADP deduplicates it instead of
        appending it twice. A random id would make the resume protocol produce
        exactly the corruption it exists to prevent.
        """
        seq = self._next_seq
        record = {
            **event,
            "producer_seq": seq,
            "client_event_id": event.get("client_event_id") or f"{self._producer_id}:{seq}",
        }

        with (self.root / EVENTS).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
            handle.flush()
            if self._fsync:
                os.fsync(handle.fileno())

        self._next_seq = seq + 1
        return seq

    def pending(self, since_seq: int | None = None) -> list[dict[str, Any]]:
        """Events at or above ``since_seq``, for replay after a rejection.

        Defaults to everything ADP has not acknowledged. Always contiguous and
        in order, because a batch that skips a number is rejected whole.
        """
        floor = self._accepted_through + 1 if since_seq is None else since_seq
        events = [event for event in self._read_events() if event["producer_seq"] >= floor]
        events.sort(key=lambda event: int(event["producer_seq"]))
        return events

    def trim(self, accepted_through: int) -> None:
        """Drop events ADP has acknowledged.

        The mark is written before the file is rewritten. Crashing between the
        two leaves events on disk that have already been accepted, which
        ``pending`` filters out — the harmless direction. The other order would
        drop events while still claiming they were unsent.
        """
        if accepted_through < self._accepted_through:
            raise SpoolCorrupt(
                f"ADP acknowledged through {accepted_through}, behind the "
                f"{self._accepted_through} it had already acknowledged; this spool "
                "cannot supply events it has dropped"
            )
        if accepted_through == self._accepted_through:
            return

        self._accepted_through = accepted_through
        self._write_state()

        remaining = [
            event for event in self._read_events() if event["producer_seq"] > accepted_through
        ]
        self._rewrite_events(remaining)

    def can_resume_from(self, seq: int) -> bool:
        """Whether the spool still holds everything from ``seq`` onwards.

        False means ADP is asking to be replayed from a point this spool has
        already dropped, which no retry recovers — it is a divergence to report,
        not a condition to loop on.
        """
        return seq > self._accepted_through

    # --- disk -----------------------------------------------------------------

    def _read_events(self) -> list[dict[str, Any]]:
        path = self.root / EVENTS
        if not path.exists():
            return []

        events: list[dict[str, Any]] = []
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                # A half-written final line is what a kill mid-append looks
                # like. Anything earlier is real corruption.
                if number == len(path.read_text(encoding="utf-8").splitlines()):
                    break
                raise SpoolCorrupt(f"{path}:{number} is not valid JSON") from None
            events.append(event)
        return events

    def _last_seq_on_disk(self) -> int:
        events = self._read_events()
        return max((int(event["producer_seq"]) for event in events), default=0)

    def _rewrite_events(self, events: list[dict[str, Any]]) -> None:
        path = self.root / EVENTS
        handle, temporary = tempfile.mkstemp(dir=self.root, suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                for event in events:
                    out.write(json.dumps(event, separators=(",", ":")) + "\n")
                out.flush()
                if self._fsync:
                    os.fsync(out.fileno())
            os.replace(temporary, path)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise

    def _load_state(self) -> dict[str, Any] | None:
        path = self.root / STATE
        if not path.exists():
            return None
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SpoolCorrupt(f"{path} is not valid JSON: {exc}") from None
        if not isinstance(state, dict) or "producer_id" not in state:
            raise SpoolCorrupt(f"{path} is not a spool state file")
        return state

    def _write_state(self) -> None:
        path = self.root / STATE
        handle, temporary = tempfile.mkstemp(dir=self.root, suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as out:
                json.dump(
                    {
                        "producer_id": self._producer_id,
                        "accepted_through": self._accepted_through,
                    },
                    out,
                )
                out.flush()
                os.fsync(out.fileno())
            os.replace(temporary, path)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
