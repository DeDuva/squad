"""Replay under substituted models.

Task 2.1 — fork-at-zero (a model comparison).
Task 2.2 — fork-at-step (a continuation diagnostic, never a model comparison).
Task 2.3 — cross-provider experiment runner.
"""

from adp_replay.replay.agent import AgentRunner, AttemptOutcome, AttemptRequest, Scorer
from adp_replay.replay.fork import (
    CONTINUATION_BANNER,
    Attempt,
    ReplayResult,
    ScorerMismatchError,
    assert_comparable,
    fork_at_step,
    fork_at_zero,
)
from adp_replay.replay.runner import (
    BudgetExceeded,
    Cell,
    CostLedger,
    Progress,
    RateLimiter,
    SelfReportedScores,
    assert_separately_authorized,
    plan_cells,
    remaining,
)

__all__ = [
    "CONTINUATION_BANNER",
    "AgentRunner",
    "Attempt",
    "AttemptOutcome",
    "AttemptRequest",
    "BudgetExceeded",
    "Cell",
    "CostLedger",
    "Progress",
    "RateLimiter",
    "ReplayResult",
    "Scorer",
    "ScorerMismatchError",
    "SelfReportedScores",
    "assert_comparable",
    "assert_separately_authorized",
    "fork_at_step",
    "fork_at_zero",
    "plan_cells",
    "remaining",
]
