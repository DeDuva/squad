"""The recorder (Task 1.4).

Captures outbound requests, tool execution, and state deltas, and emits them to
ADP. The done-condition is a blunt one: kill the recorder mid-run, start it
again, and the chain ADP holds is complete and gap-free.

Three rules shape the whole design.

**A tool call never blocks on an ADP write.** :meth:`Recorder.record` appends to
a local spool and returns; a background thread does the network. The G1 budget
is 10% wall-clock overhead *inclusive of ADP round-trips*, and a synchronous
append would put network latency directly on the agent's critical path.

**A retry must not duplicate.** ``client_event_id`` is derived from the producer
id and the sequence number, so a replayed event carries the id it had the first
time and ADP drops it instead of appending it twice.

**A gap must not pass silently.** Batches are contiguous and numbered; ADP
rejects one that skips, naming the sequence it wants, and the flush loop replays
from there. That is what makes ``emitters_ok`` in Task 3.3's verification worth
reading — the recorder is what it is checking up on.
"""

from __future__ import annotations

import itertools
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any, Self

from adp_replay.adp.client import AdpClient, AdpError, AppendRejected
from adp_replay.recording.spool import Spool

logger = logging.getLogger(__name__)

MAX_BATCH = 1000  # ADP's documented ceiling.


class RecorderStopped(RuntimeError):
    """The flush loop gave up, and the reason is not something a retry fixes."""


@dataclass
class RecorderStats:
    """What the recorder did, and what it noticed while doing it."""

    recorded: int = 0
    appended: int = 0
    batches: int = 0
    retries: int = 0
    resumes: int = 0
    # Duplicates ADP reported after a resend whose outcome this client could not
    # observe — a response lost in flight. Expected under at-least-once
    # delivery, and counted separately so it does not mask the case below.
    duplicates_after_retry: int = 0
    # Duplicates with no ambiguous send to explain them. This is the bug signal
    # the plan means: it says the recorder sent something twice believing it had
    # not, which means its own view of what ADP holds is wrong.
    unexpected_duplicates: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def duplicates(self) -> int:
        return self.duplicates_after_retry + self.unexpected_duplicates


class Recorder:
    """Spools trajectory events and flushes them to ADP asynchronously."""

    def __init__(
        self,
        client: AdpClient,
        owner: str,
        repo: str,
        session_id: str,
        spool: Spool,
        *,
        batch_size: int = 200,
        poll_interval: float = 0.05,
        max_backoff: float = 5.0,
        on_unexpected_duplicates: Callable[[tuple[str, ...]], None] | None = None,
    ) -> None:
        if not 1 <= batch_size <= MAX_BATCH:
            raise ValueError(f"batch_size must be between 1 and {MAX_BATCH}")

        self._client = client
        self._owner = owner
        self._repo = repo
        self._session_id = session_id
        self._spool = spool
        self._batch_size = batch_size
        self._poll_interval = poll_interval
        self._max_backoff = max_backoff
        self._on_unexpected_duplicates = on_unexpected_duplicates

        self.stats = RecorderStats()
        self._thread: threading.Thread | None = None
        self._stopping = threading.Event()
        self._idle = threading.Event()
        self._idle.set()
        self._fatal: BaseException | None = None
        self._lock = threading.Lock()
        # True while a send's outcome is unknown, so the next response's
        # duplicates are explained by this client's own resend.
        self._ambiguous = False

    # --- lifecycle ------------------------------------------------------------

    def __enter__(self) -> Self:
        self.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stopping.clear()
        self._thread = threading.Thread(target=self._run, name="adp-replay-recorder", daemon=True)
        self._thread.start()

    def close(self, timeout: float = 30.0) -> None:
        """Flush what is spooled, then stop.

        Flushing on the way out is the difference between a recorder and a
        best-effort logger: the last few events of a run are the ones that say
        how it ended.
        """
        try:
            self.flush(timeout=timeout)
        finally:
            self._stopping.set()
            thread, self._thread = self._thread, None
            if thread is not None:
                thread.join(timeout=timeout)
        self.raise_if_failed()

    # --- recording ------------------------------------------------------------

    def record(self, kind: str, **fields: Any) -> int:
        """Spool one event and return immediately with its ``producer_seq``.

        Never touches the network. If the flush loop has already failed
        fatally, that surfaces here rather than being spooled into a void.
        """
        self.raise_if_failed()
        with self._lock:
            seq = self._spool.append({"kind": kind, **fields})
        self.stats.recorded += 1
        self._idle.clear()
        return seq

    def flush(self, timeout: float = 30.0) -> bool:
        """Block until the spool is empty. Returns False on timeout."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.raise_if_failed()
            with self._lock:
                if not self._spool.pending():
                    return True
            if self._thread is None:
                # Nothing is draining it; flushing synchronously is better than
                # spinning until the deadline.
                self._flush_once()
                continue
            self._idle.wait(timeout=self._poll_interval)
        with self._lock:
            return not self._spool.pending()

    def raise_if_failed(self) -> None:
        if self._fatal is not None:
            raise RecorderStopped(str(self._fatal)) from self._fatal

    # --- the flush loop -------------------------------------------------------

    def _run(self) -> None:
        backoff = self._poll_interval
        while not self._stopping.is_set():
            try:
                sent = self._flush_once()
            except BaseException as exc:
                self._fatal = exc
                self._idle.set()
                logger.exception("recorder stopped")
                return

            if sent:
                backoff = self._poll_interval
                continue

            self._idle.set()
            self._stopping.wait(timeout=backoff)
            backoff = min(backoff * 2, self._max_backoff)

    def _flush_once(self) -> int:
        """Send at most one batch. Returns how many events were accepted."""
        with self._lock:
            batch = self._spool.pending()[: self._batch_size]
        if not batch:
            return 0

        _assert_contiguous(batch)
        try:
            receipt = self._client.append_events(
                self._owner,
                self._repo,
                self._session_id,
                batch,
                producer_id=self._spool.producer_id,
            )
        except AppendRejected as rejection:
            self._resume(rejection)
            return 0
        except (AdpError, OSError) as error:
            # The request reached ADP and came back unhappy, or never came back
            # at all. Either way this client cannot tell whether the batch
            # landed, so the resend is legitimate and any duplicates it reports
            # are expected rather than a bug signal. That is what _ambiguous
            # records, and why it is not simply "did we retry".
            self.stats.retries += 1
            self.stats.errors.append(str(error))
            self._ambiguous = True
            self._stopping.wait(timeout=min(self._poll_interval * 4, self._max_backoff))
            return 0

        ambiguous, self._ambiguous = self._ambiguous, False

        if receipt.duplicates:
            if ambiguous:
                self.stats.duplicates_after_retry += receipt.duplicate_count
            else:
                self.stats.unexpected_duplicates += receipt.duplicate_count
                logger.warning(
                    "ADP reported %d duplicate event(s) with no ambiguous send to explain "
                    "them: %s. The recorder's view of what ADP holds is wrong.",
                    receipt.duplicate_count,
                    receipt.duplicates,
                )
                if self._on_unexpected_duplicates is not None:
                    self._on_unexpected_duplicates(receipt.duplicates)

        self.stats.batches += 1
        self.stats.appended += receipt.appended

        if receipt.accepted_through is not None:
            with self._lock:
                self._spool.trim(receipt.accepted_through)
        return receipt.appended or len(batch)

    def _resume(self, rejection: AppendRejected) -> None:
        """Replay from where ADP says it is, or stop if it cannot be reached.

        A 409 carries two different conditions. With ``expected_next_seq`` the
        session is open and merely ahead of or behind this batch, which the
        spool can fix. Without it the session is closed, and no amount of
        replaying changes that.
        """
        expected = rejection.expected_next_seq
        if expected is None:
            raise RecorderStopped(
                f"ADP rejected the append and offered no resume point, so the session is "
                f"closed: {rejection}"
            ) from rejection

        with self._lock:
            if not self._spool.can_resume_from(expected):
                raise RecorderStopped(
                    f"ADP asked to be replayed from producer_seq {expected}, which this "
                    f"spool trimmed at {self._spool.accepted_through}. ADP is missing "
                    "events it acknowledged; this is not recoverable by retrying."
                ) from rejection
            # ADP already holds everything below the resume point, whatever this
            # client believed. Trimming to match is what makes the next batch
            # start where ADP is waiting.
            self._spool.trim(expected - 1)

        self.stats.resumes += 1
        logger.info("resuming from producer_seq %d at ADP's request", expected)


def _assert_contiguous(batch: list[dict[str, Any]]) -> None:
    """A batch that skips a number is rejected whole, so never send one.

    Checked locally because the failure is a bug in this client, and finding it
    here names the batch rather than leaving a 409 to be interpreted.
    """
    for previous, event in itertools.pairwise(batch):
        if int(event["producer_seq"]) != int(previous["producer_seq"]) + 1:
            raise RecorderStopped(
                f"batch is not contiguous: {previous['producer_seq']} followed by "
                f"{event['producer_seq']}"
            )
