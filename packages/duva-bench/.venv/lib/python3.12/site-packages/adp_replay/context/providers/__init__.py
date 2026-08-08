"""Provider wire-format translators.

These render a canonical context into a provider's request shape and parse it
back. The round-trip is what the fidelity probe measures against (Task 0.3b), so
these are not illustrative: what a translator drops, the replayed model does not
see.

Two things they are not. They are not a claim about a provider's internals —
they encode *this repository's translation policy*, and the pre-registered
grounding check (the rendered request must additionally be accepted by the
provider's API) is what validates that policy against reality. Until that check
runs, every score derived from them is reported as round-trip-only, exactly as
registered. And they are not a lookup table of expected losses: the classifier
learns what survived by round-tripping, which is why a translator bug shows up
as a fidelity number rather than hiding behind one.
"""

from adp_replay.context.providers.anthropic import AnthropicTranslator
from adp_replay.context.providers.base import Translator, round_trip
from adp_replay.context.providers.google import GoogleTranslator
from adp_replay.context.providers.openai import OpenAITranslator

TRANSLATORS: dict[str, Translator] = {
    "anthropic": AnthropicTranslator(),
    "openai": OpenAITranslator(),
    "google": GoogleTranslator(),
}

__all__ = [
    "TRANSLATORS",
    "AnthropicTranslator",
    "GoogleTranslator",
    "OpenAITranslator",
    "Translator",
    "round_trip",
]
