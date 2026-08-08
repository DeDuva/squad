"""The translator seam, and the round-trip the probe is defined in terms of."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from adp_replay.context.canonical import CanonicalContext, Element, Role, Turn
from adp_replay.context.registered import ElementType


class Translator(Protocol):
    """Renders a canonical context to one provider's request shape, and back."""

    name: str

    def render(self, context: CanonicalContext) -> dict[str, Any]:
        """The provider request this context becomes."""
        ...

    def parse(self, request: Mapping[str, Any]) -> CanonicalContext:
        """The canonical context that request represents."""
        ...


def round_trip(context: CanonicalContext, translator: Translator) -> CanonicalContext:
    """What survives a trip through ``translator``'s wire format.

    This is the registered classification procedure's first two steps. Comparing
    the result with the original is the third.
    """
    return translator.parse(translator.render(context))


# --- helpers shared by the concrete translators -------------------------------


def request_level(context: CanonicalContext) -> dict[ElementType, list[Element]]:
    """Elements that belong to the request rather than to a turn."""
    grouped: dict[ElementType, list[Element]] = {}
    for element in context.elements:
        if element.turn is None:
            grouped.setdefault(element.type, []).append(element)
    return grouped


def first(context: CanonicalContext, element_type: ElementType) -> Element | None:
    found = context.of_type(element_type)
    return found[0] if found else None


def group_turns(
    turns: tuple[Turn, ...], wire_role: Mapping[Role, str]
) -> list[tuple[str, list[Element]]]:
    """Group canonical turns into wire messages, merging same-role neighbours.

    Providers that require alternating roles force the merge. The collapse stays
    visible afterwards because the parsed role sequence is shorter than the
    source's, which the metric reads as a transform rather than as nothing
    having happened.
    """
    grouped: list[tuple[str, list[Element]]] = []
    for turn in turns:
        role = wire_role[turn.role]
        if grouped and grouped[-1][0] == role:
            grouped[-1][1].extend(turn.parts)
        else:
            grouped.append((role, list(turn.parts)))
    return grouped
