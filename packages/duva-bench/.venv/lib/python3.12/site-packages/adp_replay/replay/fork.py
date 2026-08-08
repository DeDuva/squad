"""Fork-at-zero (Task 2.1) and fork-at-step (Task 2.2)."""

from __future__ import annotations

import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from adp_replay.context.canonical import CanonicalContext
from adp_replay.manifest.models import ModelSpec, ReplayMode
from adp_replay.replay.agent import AgentRunner, AttemptOutcome, AttemptRequest
from adp_replay.storage.capture import restore_tree
from adp_replay.storage.castore import CAStore
from adp_replay.verdict.gating import Verdict

# Carried verbatim by every artifact, report, and console run that includes
# fork-at-step results. Not suppressible by configuration: the whole reason the
# banner exists is that a continuation diagnostic reads like a model comparison
# to anyone who did not run it, and the one place it would be most tempting to
# omit is the summary someone actually quotes.
CONTINUATION_BANNER = (
    "Continuation diagnostic: measures Model B's ability to continue Model A's "
    "trajectory prefix. Not a pinned-harness model comparison."
)


class ScorerMismatchError(RuntimeError):
    """Raised when results carrying different scorer digests would be compared.

    Scorer identity is ADP's ``spec_digest`` on the eval. Two results produced by
    different scorers are not comparable, and aggregating them anyway is how an
    eval-gated result reports the wrong winner.
    """


@dataclass(frozen=True)
class Attempt:
    """One repetition: what it did, and what makes its verdict admissible."""

    task_id: str
    model: ModelSpec
    repetition: int
    outcome: AttemptOutcome
    verdict: Verdict
    # ADP's spec_digest on the eval: the identity of whatever decided pass or
    # fail, and the thing two results must share to be comparable.
    scorer_spec_digest: str | None = None
    separately_authorized: bool | None = None
    run_id: str | None = None
    session_id: str | None = None
    trajectory_digest: str | None = None
    downgraded_because: tuple[str, ...] = ()


# How one attempt is actually carried out end to end — recorded, closed, scored,
# and gated. Injected so that fork_at_zero and fork_at_step stay about *what* is
# replayed rather than about ADP bookkeeping.
Execute = Callable[[AttemptRequest, AgentRunner], Attempt]


@dataclass(frozen=True)
class ReplayResult:
    """The attempts of one (task, model) cell, under one mode."""

    task_id: str
    model: ModelSpec
    mode: ReplayMode
    attempts: tuple[Attempt, ...] = ()
    forked_from_step: int | None = None
    notes: dict[str, Any] = field(default_factory=dict)

    @property
    def banner(self) -> str | None:
        """The Task 2.2 banner, when this result is a continuation diagnostic.

        A property computed from the mode: no field behind it, no parameter that
        turns it off. The banner cannot be suppressed by configuration because
        there is no configuration — a fork-at-step result has it, and that is a
        fact about the mode rather than a choice about presentation.
        """
        return CONTINUATION_BANNER if self.mode is ReplayMode.FORK_AT_STEP else None

    @property
    def is_model_comparison(self) -> bool:
        """Only fork-at-zero is. This is the load-bearing distinction."""
        return self.mode is ReplayMode.FORK_AT_ZERO

    @property
    def scorer_digests(self) -> frozenset[str]:
        return frozenset(
            attempt.scorer_spec_digest
            for attempt in self.attempts
            if attempt.scorer_spec_digest is not None
        )

    @property
    def passes(self) -> int:
        return sum(1 for attempt in self.attempts if attempt.verdict is Verdict.PASS)

    @property
    def errors(self) -> int:
        """Attempts whose evidence did not verify. Never counted as failures."""
        return sum(1 for attempt in self.attempts if attempt.verdict is Verdict.ERROR)

    @property
    def solved(self) -> bool:
        """The registered primary outcome: a majority of repetitions passed.

        Errors count against the majority rather than being dropped. Dropping
        them would let a cell with one pass and four unverifiable attempts
        report as solved.
        """
        return bool(self.attempts) and self.passes * 2 > len(self.attempts)

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "task_id": self.task_id,
            "model": {"provider": self.model.provider, "model": self.model.model},
            "mode": self.mode.value,
            "is_model_comparison": self.is_model_comparison,
            "repetitions": len(self.attempts),
            "passes": self.passes,
            "errors": self.errors,
            "solved": self.solved,
            "scorer_spec_digests": sorted(self.scorer_digests),
            "forked_from_step": self.forked_from_step,
        }
        # Serialized whenever it applies, for the same reason it is a property:
        # the summary someone quotes is exactly where omitting it would be most
        # tempting and most misleading.
        if self.banner is not None:
            payload["banner"] = self.banner
        return payload


def assert_comparable(results: Sequence[ReplayResult]) -> str | None:
    """Refuse any comparison across differing scorer digests.

    Task 2.1's done-condition. Errors rather than aggregating: two results
    produced by different scorers are not two measurements of the same thing,
    and averaging them produces a number with no referent.
    """
    digests = {digest for result in results for digest in result.scorer_digests}
    if len(digests) > 1:
        detail = ", ".join(
            f"{result.task_id}/{result.model.model}={sorted(result.scorer_digests)}"
            for result in results
            if result.scorer_digests
        )
        raise ScorerMismatchError(
            f"results were produced by {len(digests)} different scorers and cannot be "
            f"compared: {detail}. Re-score them under one eval definition, or compare "
            "only results that already share a spec_digest."
        )

    unscored = sorted({result.task_id for result in results if not result.scorer_digests})
    if unscored:
        raise ScorerMismatchError(
            f"these results carry no scorer identity at all, so nothing establishes "
            f"they are comparable: {unscored}"
        )
    return next(iter(digests), None)


def _run_repetitions(
    *,
    task_id: str,
    model: ModelSpec,
    mode: ReplayMode,
    base_state: str | None,
    store: CAStore | None,
    context: CanonicalContext,
    repetitions: int,
    agent: AgentRunner,
    execute: Execute,
    resumed_from_step: int | None = None,
) -> ReplayResult:
    """Materialize state, then run independent repetitions.

    Each repetition gets its own workspace restored from the same base state.
    Sharing one would make repetition *n* depend on what repetition *n-1* left
    behind, which is the opposite of an independent sample.
    """
    attempts: list[Attempt] = []
    for repetition in range(1, repetitions + 1):
        with tempfile.TemporaryDirectory(prefix=f"adp-replay-{task_id.replace('/', '-')}-") as tmp:
            workspace = Path(tmp) / "work"
            workspace.mkdir(parents=True)
            if base_state is not None and store is not None:
                restore_tree(store.get(base_state), workspace)

            request = AttemptRequest(
                task_id=task_id,
                workspace=workspace,
                context=context,
                model=model,
                recorder=None,  # type: ignore[arg-type]
                repetition=repetition,
                resumed_from_step=resumed_from_step,
            )
            attempts.append(execute(request, agent))

    return ReplayResult(
        task_id=task_id,
        model=model,
        mode=mode,
        attempts=tuple(attempts),
        forked_from_step=resumed_from_step,
    )


def fork_at_zero(
    task_id: str,
    model: ModelSpec,
    repetitions: int,
    *,
    context: CanonicalContext,
    agent: AgentRunner,
    execute: Execute,
    base_state: str | None = None,
    store: CAStore | None = None,
) -> ReplayResult:
    """Replay ``task_id`` from its initial state under ``model``, harness pinned.

    Task 2.1. This is a model comparison and may be described as one: the only
    thing differing between conditions is the model, because the harness, the
    tools, the environment digest, and the initial context are all fixed.
    """
    if repetitions < 1:
        raise ValueError("a replay needs at least one repetition")

    return _run_repetitions(
        task_id=task_id,
        model=model,
        mode=ReplayMode.FORK_AT_ZERO,
        base_state=base_state,
        store=store,
        context=context,
        repetitions=repetitions,
        agent=agent,
        execute=execute,
    )


def fork_at_step(
    task_id: str,
    model: ModelSpec,
    step: int,
    repetitions: int = 1,
    *,
    context: CanonicalContext,
    agent: AgentRunner,
    execute: Execute,
    base_state: str | None = None,
    store: CAStore | None = None,
) -> ReplayResult:
    """Resume ``task_id`` from ``step`` under ``model``.

    Task 2.2. **Not a model comparison.** What it measures is one model's ability
    to continue another's trajectory prefix, which is a different quantity that
    happens to be reported in the same units. Results carry
    :data:`CONTINUATION_BANNER`, and :attr:`ReplayResult.banner` is computed
    rather than stored so that no configuration can drop it.
    """
    if step < 1:
        raise ValueError("fork_at_step resumes from step 1 or later")
    if repetitions < 1:
        raise ValueError("a replay needs at least one repetition")

    return _run_repetitions(
        task_id=task_id,
        model=model,
        mode=ReplayMode.FORK_AT_STEP,
        base_state=base_state,
        store=store,
        context=context,
        repetitions=repetitions,
        agent=agent,
        execute=execute,
        resumed_from_step=step,
    )
