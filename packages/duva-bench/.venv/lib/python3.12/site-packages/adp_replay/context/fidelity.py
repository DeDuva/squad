"""Context-fidelity scoring (Tasks 0.3a and 0.3b).

Gate G0's threshold and the metric's definition are pre-registered in
``docs/pre-registration.md`` **before** this module was written: a metric whose
pass mark is settled by the same work that measures against it can be shaped to
clear its own bar. The number itself is deliberately not repeated here — it
lives in :mod:`adp_replay.context.registered` and nowhere else, which
``tests/test_registered_metric.py`` enforces.

Implementations here must read the pre-registered definition, not restate it —
so every number this module applies comes from
:mod:`adp_replay.context.registered`, and there is not one literal weight,
coefficient, or threshold below.

The classification is the registered procedure, in order: render the context
into the target's wire format, parse it back, and compare. Two passes over the
result, matching first on the full payload and then on content alone, which is
exactly the difference between *preserved* and *transformed*.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from adp_replay.context.canonical import CanonicalContext, Element, Role, normalize
from adp_replay.context.providers.base import Translator, round_trip
from adp_replay.context.registered import (
    BINDING_RECOVERABLE_IS_PRESERVED,
    ELEMENT_WEIGHTS,
    Classification,
    ElementType,
    coefficient_of,
    weight_of,
)

# Amendment 1: the attribute that carries a call-to-result binding, per type.
_BINDING_KEY = {
    ElementType.TOOL_CALL: "id",
    ElementType.TOOL_RESULT: "call_id",
}


@dataclass(frozen=True)
class ElementVerdict:
    """What became of one source element."""

    element: Element
    classification: Classification


@dataclass(frozen=True)
class FidelityScore:
    """One provider pair's fidelity, and what accounts for the shortfall."""

    score: float
    preserved: tuple[str, ...] = ()
    transformed: tuple[str, ...] = ()
    lost: tuple[str, ...] = ()
    # Per-type fidelity, the intermediate the registered aggregation goes
    # through. Kept because "0.78" is not a finding, and "every tool definition
    # survived and every reasoning trace did not" is.
    per_type: Mapping[str, float] = field(default_factory=dict)
    notes: dict[str, Any] = field(default_factory=dict)


def order_recoverable_bindings(context: CanonicalContext) -> frozenset[int]:
    """Indices of elements whose call-to-result binding survives losing its id.

    Amendment 1. An assistant turn issuing exactly one tool call, answered by a
    tool turn carrying exactly one result, pairs by order: a format that matches
    by name rather than by id reconstructs it without ambiguity, and charging
    that a transform would be scoring a loss the model cannot experience.

    Two or more calls outstanding is the case the amendment deliberately does
    not cover. There the answers really can be attributed to the wrong call, and
    no care in the translator recovers it.
    """
    turns = context.turns()
    if not turns:
        return frozenset()

    by_turn: dict[int, list[tuple[int, Element]]] = {}
    for index, element in enumerate(context.elements):
        if element.turn is not None:
            by_turn.setdefault(element.turn, []).append((index, element))

    recoverable: set[int] = set()
    for position, turn in enumerate(turns):
        if turn.role is not Role.ASSISTANT:
            continue
        calls = [
            index
            for index, element in by_turn.get(position, [])
            if element.type is ElementType.TOOL_CALL
        ]
        if len(calls) != 1:
            continue

        answering = next(
            (i for i in range(position + 1, len(turns)) if turns[i].role is Role.TOOL), None
        )
        if answering is None:
            # The call is the last thing in the context; nothing can be
            # misattributed to it yet.
            recoverable.update(calls)
            continue

        results = [
            index
            for index, element in by_turn.get(answering, [])
            if element.type is ElementType.TOOL_RESULT
        ]
        if len(results) == 1:
            recoverable.update(calls)
            recoverable.update(results)

    return frozenset(recoverable)


def classify(
    source: CanonicalContext,
    target: CanonicalContext,
    *,
    binding_carve_out: bool = BINDING_RECOVERABLE_IS_PRESERVED,
) -> tuple[ElementVerdict, ...]:
    """Classify every element of ``source`` against the round-tripped ``target``.

    Matching consumes target elements, so two source elements cannot both take
    credit for surviving as the same one. Without that, a translator that
    collapsed three tool results into one would score as though all three
    arrived.

    ``binding_carve_out`` selects Amendment 1. It is a parameter rather than a
    constant so that the pre-amendment reading stays computable: the
    registration requires results under the old definition to be reported
    beside results under the new one, and an amendment that deleted its own
    predecessor would make that impossible.
    """
    targets = list(target.elements)
    consumed: set[int] = set()
    verdicts: dict[int, Classification] = {}
    recoverable = order_recoverable_bindings(source) if binding_carve_out else frozenset()

    target_by_type: dict[ElementType, list[tuple[int, Element]]] = {}
    for index, element in enumerate(targets):
        target_by_type.setdefault(element.type, []).append((index, element))

    source_by_type: dict[ElementType, list[tuple[int, Element]]] = {}
    for index, element in enumerate(source.elements):
        source_by_type.setdefault(element.type, []).append((index, element))

    # Pass 1 — preserved: same type, same position within that type, equal
    # payload. Position matters because "the third tool call" arriving in place
    # of the first is not the same context.
    for element_type, sources in source_by_type.items():
        candidates = target_by_type.get(element_type, [])
        for position, (source_index, element) in enumerate(sources):
            if position >= len(candidates):
                continue
            target_index, candidate = candidates[position]
            if target_index in consumed:
                continue
            equal = element.normalized_payload == candidate.normalized_payload
            if not equal and source_index in recoverable:
                # Amendment 1: ignore the binding attribute, and only it. Any
                # other difference still costs, so this cannot launder an
                # unrelated loss through a recoverable call.
                equal = _without_binding(element) == _without_binding(candidate)
            if equal:
                verdicts[source_index] = Classification.PRESERVED
                consumed.add(target_index)

    # Pass 2 — transformed: the content arrived, wearing a different type or
    # role, or shorn of a documented attribute.
    for source_index, element in enumerate(source.elements):
        if source_index in verdicts:
            continue
        content = element.content
        for target_index, candidate in enumerate(targets):
            if target_index in consumed:
                continue
            if candidate.content == content:
                verdicts[source_index] = Classification.TRANSFORMED
                consumed.add(target_index)
                break

    return tuple(
        ElementVerdict(element, verdicts.get(index, Classification.LOST))
        for index, element in enumerate(source.elements)
    )


def _without_binding(element: Element) -> Any:
    key = _BINDING_KEY.get(element.type)
    if key is None:
        return element.normalized_payload
    return normalize({k: v for k, v in element.payload.items() if k != key})


def score_verdicts(verdicts: Sequence[ElementVerdict]) -> FidelityScore:
    """Combine element verdicts per the registered aggregation.

    Per element *type* first, then across types by registered weight,
    renormalized over the types actually present. Never per instance: message
    text outnumbers everything else by one to two orders of magnitude, so an
    instance-weighted mean reports whether the prose survived — it reads near
    1.0 while every tool definition is being dropped.
    """
    if not verdicts:
        return FidelityScore(score=1.0)

    by_type: dict[ElementType, list[Classification]] = {}
    for verdict in verdicts:
        by_type.setdefault(verdict.element.type, []).append(verdict.classification)

    per_type = {
        element_type: sum(coefficient_of(c) for c in classes) / len(classes)
        for element_type, classes in by_type.items()
    }

    total_weight = sum(weight_of(t) for t in per_type)
    score = sum(weight_of(t) * value for t, value in per_type.items()) / total_weight

    def names(wanted: Classification) -> tuple[str, ...]:
        return tuple(v.element.type.value for v in verdicts if v.classification is wanted)

    return FidelityScore(
        score=score,
        preserved=names(Classification.PRESERVED),
        transformed=names(Classification.TRANSFORMED),
        lost=names(Classification.LOST),
        per_type={t.value: value for t, value in per_type.items()},
    )


def score_fidelity(
    source_context: CanonicalContext,
    target_context: CanonicalContext,
    *,
    binding_carve_out: bool = BINDING_RECOVERABLE_IS_PRESERVED,
) -> FidelityScore:
    """Score how much of ``source_context`` survives translation to the target.

    ``target_context`` is the round-tripped canonical context, not the target
    provider's wire payload — the registered procedure compares canonical forms
    so that neither format's vocabulary is privileged over the other's.

    Task 0.3b.
    """
    return score_verdicts(
        classify(source_context, target_context, binding_carve_out=binding_carve_out)
    )


def score_translation(
    context: CanonicalContext,
    translator: Translator,
    *,
    binding_carve_out: bool = BINDING_RECOVERABLE_IS_PRESERVED,
) -> FidelityScore:
    """Score ``context`` against a full round-trip through ``translator``."""
    return score_fidelity(
        context, round_trip(context, translator), binding_carve_out=binding_carve_out
    )


def weighted_types() -> Mapping[str, int]:
    """The registered weight table, for reports that reprint it."""
    return {element_type.value: weight for element_type, weight in ELEMENT_WEIGHTS.items()}
