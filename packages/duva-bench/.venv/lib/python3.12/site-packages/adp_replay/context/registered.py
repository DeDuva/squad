"""The pre-registered fidelity metric, in machine-readable form (Task 0.3a).

This module is a transcription of the "Context fidelity (Gate G0)" section of
``docs/pre-registration.md``, registered 2026-08-05 against ``main`` at
``062a9e5`` — before any scoring code existed.

It exists so that Task 0.3b can *read* the registered definition rather than
restate it. A metric restated at the point of use drifts from the one that was
published, and the drift is invisible precisely when it matters: a threshold is
only a commitment if the thing measured against it is the thing that was
registered. ``tests/test_registered_metric.py`` fails if this file and the
document disagree.

**Do not edit these values.** A change here is a change to a published
commitment, and is made only by adding a dated amendment to the document and
transcribing it in the same commit.
"""

from __future__ import annotations

from enum import StrEnum
from types import MappingProxyType
from typing import Final

REGISTERED_ON: Final = "2026-08-05"
REGISTERED_AGAINST_COMMIT: Final = "062a9e5"


class ElementType(StrEnum):
    """The closed vocabulary a canonical context is decomposed into.

    In-scope types only: the metric scores what the model can condition on.
    Cache breakpoints, request identifiers, retry configuration, and streaming
    flags are operational deltas, reported separately and never folded in —
    otherwise a metric about interpretability moves in response to a fact about
    billing.
    """

    SYSTEM_INSTRUCTION = "system_instruction"
    TOOL_DEFINITION = "tool_definition"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    USER_MESSAGE_TEXT = "user_message_text"
    ASSISTANT_MESSAGE_TEXT = "assistant_message_text"
    ASSISTANT_PREFILL = "assistant_prefill"
    REASONING_TRACE = "reasoning_trace"
    IMAGE_ATTACHMENT = "image_attachment"
    DOCUMENT_ATTACHMENT = "document_attachment"
    SAMPLING_PARAMS = "sampling_params"
    TOOL_CHOICE = "tool_choice"
    TURN_STRUCTURE = "turn_structure"
    REASONING_SIGNATURE = "reasoning_signature"
    CITATION_ANNOTATION = "citation_annotation"


class Classification(StrEnum):
    """What became of one element under one ordered provider pair."""

    PRESERVED = "preserved"
    TRANSFORMED = "transformed"
    LOST = "lost"


class Capability(StrEnum):
    """Scored in separate cells, never pooled.

    Fork-at-zero translates only an initial context — system prompt, tool
    definitions, task statement — which is the easy case. Pooling would let a
    near-perfect score there carry a continuation diagnostic that is
    uninterpretable on its own.
    """

    FORK_AT_ZERO = "fork_at_zero"
    FORK_AT_STEP = "fork_at_step"


# 3 — the task itself: losing it changes what is being asked.
# 2 — how the task is framed or constrained.
# 1 — provenance bookkeeping the model does not read as content.
ELEMENT_WEIGHTS: Final[MappingProxyType[ElementType, int]] = MappingProxyType(
    {
        ElementType.SYSTEM_INSTRUCTION: 3,
        ElementType.TOOL_DEFINITION: 3,
        ElementType.TOOL_CALL: 3,
        ElementType.TOOL_RESULT: 3,
        ElementType.USER_MESSAGE_TEXT: 3,
        ElementType.ASSISTANT_MESSAGE_TEXT: 2,
        ElementType.ASSISTANT_PREFILL: 2,
        ElementType.REASONING_TRACE: 2,
        ElementType.IMAGE_ATTACHMENT: 2,
        ElementType.DOCUMENT_ATTACHMENT: 2,
        ElementType.SAMPLING_PARAMS: 2,
        ElementType.TOOL_CHOICE: 2,
        ElementType.TURN_STRUCTURE: 2,
        ElementType.REASONING_SIGNATURE: 1,
        ElementType.CITATION_ANNOTATION: 1,
    }
)

# A transformed element delivers its content but not its frame. Nothing was
# known before measurement about which of the two matters more, so the neutral
# split is the only one that cannot be argued after the fact to have been chosen
# to clear the bar.
CLASSIFICATION_COEFFICIENTS: Final[MappingProxyType[Classification, float]] = MappingProxyType(
    {
        Classification.PRESERVED: 1.0,
        Classification.TRANSFORMED: 0.5,
        Classification.LOST: 0.0,
    }
)

# Every in-scope cell must clear this. Not "the pooled median", not "most cells".
G0_THRESHOLD: Final = 0.85

# Provider scope at registration. Narrowing to a floor of two providers is
# pre-approved (execution-plan cut line 1); anything else needs an amendment.
REGISTERED_PROVIDERS: Final[tuple[str, ...]] = ("anthropic", "openai", "google")
MINIMUM_PROVIDERS: Final = 2

# Amendment 1 (2026-08-05). A tool call's id, and a tool result's binding to it,
# are scored preserved when the binding is reconstructable without them — at
# most one call outstanding, so call and response pair by order alone. With two
# or more outstanding, the binding is genuinely unrecoverable and both stay
# transformed.
#
# The original rule charged a flat transform whenever the id was dropped,
# whether or not anything had become ambiguous. docs/pre-registration.md carries
# the amendment, the reading that prompted it, and the pre-amendment numbers —
# which every report continues to print alongside the new ones.
BINDING_RECOVERABLE_IS_PRESERVED: Final = True

AMENDMENTS: Final[tuple[str, ...]] = (
    "1 (2026-08-05): a dropped id is preserved when the binding is order-recoverable",
)


def weight_of(element_type: ElementType) -> int:
    """The registered weight of ``element_type``."""
    return ELEMENT_WEIGHTS[element_type]


def coefficient_of(classification: Classification) -> float:
    """The registered coefficient of ``classification``."""
    return CLASSIFICATION_COEFFICIENTS[classification]
