"""Cross-provider experiment runner (Task 2.3).

Resumable progress, concurrency controls, per-provider rate limiting, and cost
accounting — plus the one check that has to happen before any of it.

**The identity assertion runs at experiment start, before spend.** The scorer's
ADP bearer token must be a different principal than the runner's, or every score
is a self-report and ``separately_authorized`` is false. Checking that at
analysis time would establish it exactly when it is too late: the corpus is
already burned, the money is already spent, and the only remaining options are to
publish something inadmissible or to throw it away.

Two different tokens is not the same thing as two different principals, so the
check is not a string comparison. It asks ADP, by reporting a throwaway eval
under the scorer identity and reading back what ADP says about it. That is the
only answer that matters, because it is the same computation Task 3.3 will gate
the real verdicts on.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from adp_replay.adp.client import AdpClient
from adp_replay.manifest.models import ModelSpec, ReplayMode

PREFLIGHT_EVAL_NAME = "adp-replay-preflight"


class SelfReportedScores(RuntimeError):
    """The scorer and the runner are the same principal."""


class BudgetExceeded(RuntimeError):
    """The experiment would spend past its ceiling."""


@dataclass(frozen=True)
class Cell:
    """One unit of work: a task, a model, a mode, and a repetition."""

    task_id: str
    model: ModelSpec
    mode: ReplayMode
    repetition: int
    forked_from_step: int | None = None

    @property
    def key(self) -> str:
        """Stable identity, so resuming can tell what is already done."""
        step = "" if self.forked_from_step is None else f"@{self.forked_from_step}"
        return (
            f"{self.task_id}|{self.model.provider}:{self.model.model}|"
            f"{self.mode.value}{step}|{self.repetition}"
        )


class RateLimiter:
    """A token bucket per provider.

    Per provider rather than global: providers have separate quotas, and one
    slow provider throttling the others turns a cross-provider experiment into a
    serial one.
    """

    def __init__(self, per_second: float, burst: int | None = None) -> None:
        if per_second <= 0:
            raise ValueError("per_second must be positive")
        self._per_second = per_second
        self._capacity = float(burst if burst is not None else max(1.0, per_second))
        self._tokens = self._capacity
        self._updated = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self, *, now: float | None = None, sleep: Any = time.sleep) -> float:
        """Block until a request may go out. Returns how long it waited."""
        with self._lock:
            current = time.monotonic() if now is None else now
            elapsed = max(0.0, current - self._updated)
            self._updated = current
            self._tokens = min(self._capacity, self._tokens + elapsed * self._per_second)

            if self._tokens >= 1.0:
                self._tokens -= 1.0
                return 0.0

            wait = (1.0 - self._tokens) / self._per_second
            self._tokens = 0.0
            self._updated = current + wait

        sleep(wait)
        return wait


@dataclass
class CostLedger:
    """What the experiment has spent, and what it is allowed to.

    The ceiling is enforced *before* a cell runs rather than reported after. An
    experiment that notices its overspend at the end has already overspent.
    """

    budget_micro_usd: int | None = None
    spent_micro_usd: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    by_model: dict[str, int] = field(default_factory=dict)

    def check(self, estimate: int = 0) -> None:
        if self.budget_micro_usd is None:
            return
        if self.spent_micro_usd + estimate > self.budget_micro_usd:
            raise BudgetExceeded(
                f"spent {self.spent_micro_usd} micro-USD of a {self.budget_micro_usd} budget; "
                f"the next cell would take it past the ceiling"
            )

    def charge(self, model: ModelSpec, *, cost: int, tokens_in: int, tokens_out: int) -> None:
        self.spent_micro_usd += cost
        self.tokens_in += tokens_in
        self.tokens_out += tokens_out
        name = f"{model.provider}:{model.model}"
        self.by_model[name] = self.by_model.get(name, 0) + cost


class Progress:
    """Which cells are already done, kept on disk so a run can be resumed.

    Written as one JSON line per completed cell rather than a rewritten
    document: an experiment that runs for hours is an experiment that will be
    interrupted, and appending is the only shape where an interrupt cannot
    corrupt what was already recorded.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._done: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    # A half-written final line is what an interrupt looks like.
                    continue
                self._done[str(record["key"])] = record

    def __contains__(self, cell: Cell) -> bool:
        return cell.key in self._done

    def record(self, cell: Cell, payload: dict[str, Any]) -> None:
        record = {"key": cell.key, **payload}
        with self._lock:
            self._done[cell.key] = record
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, separators=(",", ":")) + "\n")
                handle.flush()

    @property
    def completed(self) -> int:
        return len(self._done)

    def get(self, cell: Cell) -> dict[str, Any] | None:
        return self._done.get(cell.key)


def assert_separately_authorized(
    client: AdpClient,
    owner: str,
    repo: str,
    *,
    intent_id: str,
    git_sha: str,
) -> str:
    """Check with ADP that a score would be independent evidence. Task 2.3.

    Runs before any spend. Reports a throwaway eval under the scorer identity
    against a throwaway run, and reads back ADP's own ``separately_authorized``.

    Comparing the two token *strings* is not this check — two different tokens
    can belong to one principal, and that configuration produces exactly the
    failure this is meant to catch while looking fine.

    Returns the run id of the probe run, which the caller abandons.
    """
    run = client.create_run(owner, repo, intent_id=intent_id, orchestrator="adp-replay-preflight")
    run_id = str(run["id"])

    result = client.report_eval(
        owner,
        repo,
        run_id,
        name=PREFLIGHT_EVAL_NAME,
        passed=True,
        git_sha=git_sha,
        spec={"preflight": "identity check", "version": 1},
        summary="Preflight: does ADP consider this scorer independent of the runner?",
    )

    if result.get("separately_authorized") is not True:
        raise SelfReportedScores(
            "ADP reports separately_authorized=false for the scorer identity "
            f"({result.get('reporter_principal')!r}), which means every score this "
            "experiment produces would be a self-report. The scorer token must belong "
            "to a different principal than the runner token — two different tokens for "
            "the same principal is not enough. Refusing to start before any spend."
        )
    return run_id


def plan_cells(
    task_ids: Iterable[str],
    models: Iterable[ModelSpec],
    repetitions: int,
    *,
    mode: ReplayMode = ReplayMode.FORK_AT_ZERO,
    forked_from_step: int | None = None,
) -> list[Cell]:
    """Every cell the experiment will run, in a stable order."""
    if repetitions < 1:
        raise ValueError("repetitions must be at least 1")

    return [
        Cell(
            task_id=task_id,
            model=model,
            mode=mode,
            repetition=repetition,
            forked_from_step=forked_from_step,
        )
        for task_id in task_ids
        for model in models
        for repetition in range(1, repetitions + 1)
    ]


def remaining(cells: Iterable[Cell], progress: Progress) -> Iterator[Cell]:
    """Cells still to run. Resuming is just skipping what is already recorded."""
    return (cell for cell in cells if cell not in progress)
