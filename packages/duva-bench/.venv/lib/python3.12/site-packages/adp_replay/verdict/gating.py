"""Evidence gating (Task 3.3).

ADP answers this in one call: ``GET /runs/{runId}/verify`` returns a single
``ok`` alongside the sub-checks that produced it — ``chains_ok`` (the events ADP
holds were not edited), ``emitters_ok`` (ADP was given all of them),
``envelope_verified``, ``trajectory_digest_matches``, and per-eval
``separately_authorized``.

If ``ok`` is false the verdict becomes ERROR. An unverifiable result is never
counted as a pass or a fail — silently scoring one is how unverifiable evidence
ends up in a published table. The failing sub-check is recorded so a downgrade
can be diagnosed rather than merely observed.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class Verdict(StrEnum):
    PASS = "pass"
    FAIL = "fail"
    ERROR = "error"


@dataclass(frozen=True)
class GatedVerdict:
    verdict: Verdict
    # Populated when the verdict was downgraded: which sub-check of the ADP
    # verify response failed.
    downgraded_because: tuple[str, ...] = ()


# The sub-checks of ADP's verify response, in the order a reader would want them
# reported: what ADP holds, whether it holds all of it, then whether the
# attestation over it stands up.
SUB_CHECKS: tuple[str, ...] = (
    "chains_ok",
    "emitters_ok",
    "envelope_verified",
    "trajectory_digest_matches",
)


def failing_checks(verify_response: Mapping[str, Any]) -> tuple[str, ...]:
    """Which sub-checks came back false, so a downgrade is diagnosable.

    ``None`` is not a failure. ADP reports ``envelope_verified`` and
    ``trajectory_digest_matches`` as null for a run it never attested — an open
    run has no envelope to check — and treating "not applicable" as "failed"
    would downgrade every verdict on a run that simply has not been closed yet.

    Missing is a different matter and *is* a failure: a response with no
    ``chains_ok`` in it is not a verify response this code understands, and
    assuming the best about a field that is not there is how a gate stops
    gating.
    """
    failures: list[str] = []
    for check in SUB_CHECKS:
        if check not in verify_response:
            failures.append(f"{check} (absent from the verify response)")
        elif verify_response[check] is False:
            failures.append(check)

    # Per-eval identity: a score reported by whoever did the work is not
    # independent evidence, whatever the chains say.
    for eval_result in verify_response.get("evals") or ():
        if not isinstance(eval_result, Mapping):
            continue
        if eval_result.get("separately_authorized") is False:
            name = eval_result.get("name") or eval_result.get("gate_name") or "eval"
            failures.append(f"separately_authorized ({name})")

    return tuple(failures)


def gate_verdict(scored: Verdict, verify_response: Mapping[str, Any]) -> GatedVerdict:
    """Downgrade ``scored`` to ERROR unless the run's evidence verifies.

    Task 3.3. An unverifiable result is never counted as a pass or a fail —
    those are claims about the model, and a run whose evidence does not stand up
    supports neither. Silently scoring one is how unverifiable evidence ends up
    in a published table.

    The failing sub-check is recorded so a downgrade can be diagnosed rather
    than merely observed: "error" tells you to look, and "emitters_ok" tells you
    where.

    ``ok`` is ADP's own single answer and is authoritative. The sub-checks are
    read anyway, because a downgrade with no reason attached is indistinguishable
    from a bug in this function.
    """
    failures = failing_checks(verify_response)
    ok = verify_response.get("ok")

    if ok is True and not failures:
        return GatedVerdict(verdict=scored)

    if not failures:
        # ADP says no and named nothing this code knows how to read. Downgrade
        # anyway — ADP's answer wins — and say so, rather than reporting an
        # unexplained error.
        failures = ("ok (ADP reported the run as not verified)",)

    return GatedVerdict(verdict=Verdict.ERROR, downgraded_because=failures)
