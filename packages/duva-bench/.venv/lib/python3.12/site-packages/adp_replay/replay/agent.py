"""The seam a harness fills (Tasks 2.1 and 2.2).

Replay orchestrates: it materializes base state, reconstructs a context, opens a
run, records, scores, and gates. What it does not do is drive a model — that is
the harness's job, and it is injected here as a protocol.

The split is not decoration. Everything this repository can be wrong about
independently of any provider — sequencing, resume, scorer identity, evidence
gating, the arithmetic — lives on this side of the seam and is tested without a
network. What lives on the other side is one function that runs an agent and
says what happened.

**No provider is called anywhere in this package.** A real experiment supplies an
Inspect-backed :class:`AgentRunner`; the tests supply one that returns a scripted
outcome. That is why Phase 2 could be built and verified here, and why running
the actual experiment is Phase 4 work that needs keys and budget.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from adp_replay.context.canonical import CanonicalContext
from adp_replay.manifest.models import ModelSpec
from adp_replay.recording.recorder import Recorder


@dataclass(frozen=True)
class AttemptOutcome:
    """What one attempt of a task produced.

    ``final_git_sha`` is what the run is closed against, so it is what every
    attestation ends up binding. An attempt that produced no commit says so with
    None and is abandoned rather than closed against a sha it did not make.
    """

    passed: bool
    score: float | None = None
    final_git_sha: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cost_micro_usd: int = 0
    summary: str = ""
    metrics: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AttemptRequest:
    """Everything an agent needs to run one attempt."""

    task_id: str
    workspace: Path
    context: CanonicalContext
    model: ModelSpec
    recorder: Recorder
    repetition: int
    # Set on fork-at-step: how much of the recorded trajectory was replayed into
    # the workspace before the substituted model took over.
    resumed_from_step: int | None = None


class AgentRunner(Protocol):
    """Runs one attempt and reports what happened."""

    def __call__(self, request: AttemptRequest) -> AttemptOutcome: ...


class Scorer(Protocol):
    """Scores a finished attempt.

    Deliberately separate from the agent, and run under a different ADP
    identity: a score is independent evidence only when the thing that produced
    it is not the thing being scored.
    """

    spec: Any
    """The eval definition. ADP digests it, and that digest is scorer identity."""

    def __call__(self, request: AttemptRequest, outcome: AttemptOutcome) -> AttemptOutcome: ...
