"""API version pinning (docs/execution-plan.md §2).

Asserted once at startup and never mid-experiment. A contract break discovered
after an experiment has begun spending has already cost the corpus; the whole
value of pinning is that it fails before that.

ADP serves its contract version in an ``ADP-API-Version`` header on every
response, including 401s and 404s, so this assertion runs before the client
holds a token — which is the case worth catching, a client pointed at the wrong
instance. See ADP's docs/api-compatibility.md for what a bump promises.

The expected version is not written here twice. It comes from the generated
module, which takes it from the vendored document the client was generated
against, so "the contract this checkout was built for" has exactly one
definition and regenerating is the only way to move it.
"""

from __future__ import annotations

from dataclasses import dataclass

from adp_replay.adp._generated import SPEC_VERSION

VERSION_HEADER = "ADP-API-Version"

# The contract this checkout was generated against. Moves only when
# `make generate` moves it.
EXPECTED_API_VERSION = SPEC_VERSION


class ApiVersionMismatch(RuntimeError):
    """The ADP instance does not serve the contract this client was built for."""


@dataclass(frozen=True)
class SemVer:
    major: int
    minor: int
    patch: int

    @classmethod
    def parse(cls, text: str) -> SemVer:
        core = text.split("-", 1)[0].split("+", 1)[0]
        parts = core.split(".")
        if len(parts) != 3 or not all(part.isdigit() for part in parts):
            raise ApiVersionMismatch(f"{text!r} is not a semver contract version")
        major, minor, patch = (int(part) for part in parts)
        return cls(major, minor, patch)


def assert_api_version(
    served: str | None,
    expected: str = EXPECTED_API_VERSION,
    *,
    allow_compatible: bool = False,
) -> None:
    """Fail loudly when ``served`` is not the contract we generated against.

    A missing header is a mismatch, not a pass: an ADP old enough to omit it is
    exactly the case this check exists to catch.

    Strict equality by default. ADP's compatibility document promises that a
    minor bump is additive and that a client generated against the previous
    version still works — but this client's paths and required fields come out
    of a *pinned* document, and pre-1.0 the cheap, loud check is the right one.
    ``allow_compatible`` opts into the documented promise: same major, and a
    minor no older than the one generated against. Nothing accepts an older
    minor, because that is a server missing fields this client was built to
    read.
    """
    if served is None:
        raise ApiVersionMismatch(
            f"ADP served no {VERSION_HEADER} header. Either it predates the versioned "
            f"contract or this is not an ADP instance; expected {expected}."
        )

    if served == expected:
        return

    if not allow_compatible:
        raise ApiVersionMismatch(
            f"ADP serves contract {served}, this client was generated against {expected}. "
            "Regenerate with `make generate` against the matching spec, or point at an "
            "instance serving the pinned contract."
        )

    served_version = SemVer.parse(served)
    expected_version = SemVer.parse(expected)
    if served_version.major != expected_version.major:
        raise ApiVersionMismatch(
            f"ADP serves contract {served}; {expected} is a different major version, which "
            "ADP documents as breaking for a generated client."
        )
    if (served_version.minor, served_version.patch) < (
        expected_version.minor,
        expected_version.patch,
    ):
        raise ApiVersionMismatch(
            f"ADP serves contract {served}, older than the {expected} this client was "
            "generated against; it may not carry fields this client reads."
        )
