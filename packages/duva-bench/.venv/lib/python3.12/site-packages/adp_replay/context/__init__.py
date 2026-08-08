"""Canonical context form and the context-fidelity probe.

Task 0.3a — define and pre-register the fidelity metric.
Task 0.3b — implement the probe.
"""

from adp_replay.context.fidelity import FidelityScore, score_fidelity
from adp_replay.context.registered import (
    CLASSIFICATION_COEFFICIENTS,
    ELEMENT_WEIGHTS,
    G0_THRESHOLD,
    Capability,
    Classification,
    ElementType,
    coefficient_of,
    weight_of,
)

__all__ = [
    "CLASSIFICATION_COEFFICIENTS",
    "ELEMENT_WEIGHTS",
    "G0_THRESHOLD",
    "Capability",
    "Classification",
    "ElementType",
    "FidelityScore",
    "coefficient_of",
    "score_fidelity",
    "weight_of",
]
