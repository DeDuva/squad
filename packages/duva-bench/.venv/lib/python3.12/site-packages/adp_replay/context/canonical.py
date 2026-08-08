"""The canonical context form (registered by Task 0.3a, built here for 0.3b).

A context is an ordered sequence of elements drawn from the closed vocabulary in
:mod:`adp_replay.context.registered`. The form is provider-neutral: every
provider's wire format is rendered *from* it and parsed *back into* it, and
neither direction is privileged. That symmetry is what makes the classification
rule operational rather than a lookup table — an element is preserved because a
round-trip returned it, not because a table said it would.

Ordering is fixed rather than incidental. The request-level elements come first
in a declared order, then the turns in the order they occurred, so that "the
i-th element of type t" means the same thing on both sides of a round-trip.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from adp_replay.context.registered import ElementType

_WHITESPACE = re.compile(r"\s+")


class Role(StrEnum):
    """Who a turn is attributed to.

    ``TOOL`` is a canonical role even though no provider has a turn type by that
    name: Anthropic carries tool results inside a user message and Google inside
    a function part. Giving them their own canonical role is what lets a
    round-trip notice that a provider merged a tool turn into a user one, which
    is a real change to what the model sees and would otherwise be invisible.
    """

    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


@dataclass(frozen=True)
class Element:
    """One scored unit of a context."""

    type: ElementType
    payload: Mapping[str, Any]
    # Which turn this element belongs to; None for request-level elements.
    # Renderers group by it; the metric never reads it, since a turn index is a
    # fact about our own bookkeeping rather than about what the model was shown.
    turn: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "payload", dict(self.payload))

    @property
    def normalized_payload(self) -> Any:
        return normalize(self.payload)

    @property
    def content(self) -> Any:
        """The part of this element that must survive for it to count as transformed.

        Everything else in the payload is a *documented attribute*: a tool call's
        id, a tool result's error flag, a tool definition's description. Losing
        one of those keeps the content and drops the frame, which is exactly the
        registered definition of a transform. Losing the content is a loss.
        """
        return content_of(self)


@dataclass(frozen=True)
class Turn:
    """A contiguous run of elements attributed to one role."""

    role: Role
    parts: tuple[Element, ...] = ()


@dataclass(frozen=True)
class CanonicalContext:
    """An ordered sequence of elements, plus the turn shape they came from."""

    elements: tuple[Element, ...] = ()
    # Free-form, never scored: which corpus and task this came from.
    labels: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "labels", dict(self.labels))

    def of_type(self, element_type: ElementType) -> tuple[Element, ...]:
        return tuple(e for e in self.elements if e.type is element_type)

    def types_present(self) -> tuple[ElementType, ...]:
        seen: list[ElementType] = []
        for element in self.elements:
            if element.type not in seen:
                seen.append(element.type)
        return tuple(seen)

    def turns(self) -> tuple[Turn, ...]:
        """Reconstruct the turn sequence from the flat element list."""
        roles = self.of_type(ElementType.TURN_STRUCTURE)
        if not roles:
            return ()
        declared = [Role(r) for r in roles[0].payload["roles"]]

        grouped: list[list[Element]] = [[] for _ in declared]
        for element in self.elements:
            if element.turn is not None and 0 <= element.turn < len(grouped):
                grouped[element.turn].append(element)
        return tuple(Turn(role=r, parts=tuple(p)) for r, p in zip(declared, grouped, strict=True))


def build(
    *,
    system: str | None = None,
    tools: Sequence[Mapping[str, Any]] = (),
    tool_choice: Mapping[str, Any] | None = None,
    sampling: Mapping[str, Any] | None = None,
    turns: Sequence[Turn] = (),
    labels: Mapping[str, str] | None = None,
) -> CanonicalContext:
    """Assemble a context in the canonical element order.

    Request-level elements first, in a fixed order, then the turns. Both sides of
    a round-trip build through here, so positional comparison within a type is
    meaningful.
    """
    elements: list[Element] = []
    if system is not None:
        elements.append(Element(ElementType.SYSTEM_INSTRUCTION, {"text": system}))
    for tool in tools:
        elements.append(Element(ElementType.TOOL_DEFINITION, tool))
    if tool_choice is not None:
        elements.append(Element(ElementType.TOOL_CHOICE, tool_choice))
    if sampling is not None:
        elements.append(Element(ElementType.SAMPLING_PARAMS, sampling))
    if turns:
        elements.append(
            Element(ElementType.TURN_STRUCTURE, {"roles": [t.role.value for t in turns]})
        )
        for index, turn in enumerate(turns):
            for part in turn.parts:
                elements.append(Element(part.type, part.payload, turn=index))

    return CanonicalContext(elements=tuple(elements), labels=labels or {})


def normalize(value: Any) -> Any:
    """The registered normalization, applied recursively.

    Text compared with surrounding whitespace stripped and internal runs
    collapsed; JSON compared key-order-insensitively; numbers compared by value,
    so an integer and the float that equals it are the same number. Without the
    last rule a translator that serializes ``max_tokens`` through JSON and back
    would show a loss that no model could observe.
    """
    if isinstance(value, str):
        return _WHITESPACE.sub(" ", value).strip()
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, Mapping):
        return tuple(sorted((str(k), normalize(v)) for k, v in value.items()))
    if isinstance(value, Iterable):
        return tuple(normalize(v) for v in value)
    return value


def content_of(element: Element) -> Any:
    """What must survive for ``element`` to count as transformed rather than lost.

    Declared per type, because "the content" is not the same thing for a tool
    definition and for a role sequence. Anything not named here is an attribute:
    it contributes to *preserved*, and its loss alone is a transform.
    """
    payload = element.payload
    match element.type:
        case (
            ElementType.SYSTEM_INSTRUCTION
            | ElementType.USER_MESSAGE_TEXT
            | ElementType.ASSISTANT_MESSAGE_TEXT
            | ElementType.ASSISTANT_PREFILL
            | ElementType.REASONING_TRACE
        ):
            return normalize(payload.get("text"))
        case ElementType.TOOL_DEFINITION:
            # Name and schema define what the model can call and how. A dropped
            # description changes how well it calls it, not whether it can.
            return (normalize(payload.get("name")), normalize(payload.get("schema")))
        case ElementType.TOOL_CALL:
            # The id binds a call to its result. Providers that match by name
            # instead still deliver the call itself.
            return (normalize(payload.get("name")), normalize(payload.get("arguments")))
        case ElementType.TOOL_RESULT:
            return normalize(payload.get("content"))
        case ElementType.IMAGE_ATTACHMENT | ElementType.DOCUMENT_ATTACHMENT:
            return (normalize(payload.get("media_type")), normalize(payload.get("data")))
        case ElementType.SAMPLING_PARAMS:
            # Temperature and the length cap are the two every provider takes;
            # top-p and stop sequences are attributes that may not survive.
            return (normalize(payload.get("temperature")), normalize(payload.get("max_tokens")))
        case ElementType.TOOL_CHOICE:
            # The mode is the content. A provider that cannot express "required"
            # and falls back to "auto" has changed what the model is obliged to
            # do, which is a loss and not a transform.
            return normalize(payload.get("mode"))
        case ElementType.TURN_STRUCTURE:
            # Merging consecutive same-role turns is the documented transform, so
            # the content is the role sequence with consecutive repeats
            # collapsed. A reordering survives neither and is a loss.
            roles = [str(r) for r in payload.get("roles", [])]
            collapsed: list[str] = []
            for role in roles:
                if not collapsed or collapsed[-1] != role:
                    collapsed.append(role)
            return tuple(collapsed)
        case ElementType.REASONING_SIGNATURE:
            return normalize(payload.get("signature"))
        case ElementType.CITATION_ANNOTATION:
            return (normalize(payload.get("source")), normalize(payload.get("text")))
    raise AssertionError(f"no content rule registered for {element.type}")
