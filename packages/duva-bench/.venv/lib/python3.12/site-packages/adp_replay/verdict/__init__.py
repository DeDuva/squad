"""Evidence-gated verdicts.

Task 3.3 — a verdict is admissible only with resolvable scorer identity and
verifiable step evidence.
"""

from adp_replay.verdict.gating import (
    SUB_CHECKS,
    GatedVerdict,
    Verdict,
    failing_checks,
    gate_verdict,
)

__all__ = ["SUB_CHECKS", "GatedVerdict", "Verdict", "failing_checks", "gate_verdict"]
