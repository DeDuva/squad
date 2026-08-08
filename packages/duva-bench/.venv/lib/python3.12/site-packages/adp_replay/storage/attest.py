"""Attesting a local snapshot to ADP (Task 1.1).

The done-condition: a snapshot digest recorded in a checkpoint verifies against
the returned envelope.

How it holds together. The snapshot bytes never leave this machine; what goes to
ADP is a small JSON object naming their digest. ADP treats that object as opaque
— it never parses it — and returns a DSSE envelope over an in-toto Statement
whose predicate carries ``stateSha256``, the SHA-256 of the state as ADP received
it. Recomputing that digest locally and finding it equal is what turns "we say
this snapshot was taken at this commit" into signed evidence.

The subtle part is that ADP hashes the *serialization*, not the structure:
``sha256(JSON.stringify(state))``, key order as received. So verification has to
reproduce the exact bytes that were sent, which means the same compact
separators, the same non-ASCII handling, and the same key order. httpx's JSON
encoding matches Node's ``JSON.stringify`` on all three, and
``tests/contract/`` holds that against a live server rather than trusting it.

One consequence worth stating: the state object must not contain floats. Python
and JavaScript agree on integers and on strings, and do not agree on the decimal
representation of every double. A snapshot manifest is paths and digests, so
this costs nothing — but it is a rule, not an accident.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from dataclasses import dataclass
from typing import Any

CHECKPOINT_PREDICATE_TYPE = "https://adp.dev/attestations/checkpoint/v1"


class AttestationError(RuntimeError):
    """A checkpoint envelope does not attest what it was supposed to."""


def state_bytes(state: Any) -> bytes:
    """The exact bytes ADP will hash, given ``state``.

    Compact separators and no ASCII escaping, because that is what both httpx
    and ``JSON.stringify`` produce. Key order is preserved rather than sorted:
    ADP hashes what arrived, so sorting here would compute a digest of something
    that was never sent.
    """
    _reject_floats(state)
    return json.dumps(state, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def state_digest(state: Any) -> str:
    """SHA-256 of the state as ADP hashes it — bare hex, ADP's own form."""
    return hashlib.sha256(state_bytes(state)).hexdigest()


def snapshot_state(digest: str, **extra: Any) -> dict[str, Any]:
    """The checkpoint state this project stores for a snapshot.

    Deliberately tiny. ADP never parses it, so its shape is entirely this
    project's business, and the only thing that has to be in it is the digest
    that binds the attestation to bytes held locally.
    """
    return {"snapshot": digest, **extra}


@dataclass(frozen=True)
class CheckpointAttestation:
    """A verified checkpoint: what it binds, and to what."""

    git_sha: str
    session_id: str
    seq: int
    state_sha256: str
    trajectory_head: str | None
    event_count: int | None


def decode_statement(envelope: dict[str, Any]) -> dict[str, Any]:
    """Decode the in-toto Statement out of a DSSE envelope."""
    payload = envelope.get("payload")
    if not isinstance(payload, str):
        raise AttestationError("envelope has no base64 payload")
    try:
        decoded = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise AttestationError(f"envelope payload is not valid base64: {exc}") from None
    try:
        statement = json.loads(decoded)
    except json.JSONDecodeError as exc:
        raise AttestationError(f"envelope payload is not JSON: {exc}") from None
    if not isinstance(statement, dict):
        raise AttestationError("envelope payload is not an in-toto Statement")
    return statement


def verify_checkpoint(
    checkpoint: dict[str, Any], *, state: Any, git_sha: str | None = None
) -> CheckpointAttestation:
    """Check that ADP's envelope attests the snapshot we actually stored.

    Raises rather than returning a boolean. The only reason to call this is to
    rely on the answer, and an unchecked False is how an unverifiable snapshot
    ends up in a published table.

    Note what this does *not* do: it does not check the signature. Verifying the
    envelope's signature needs ADP's public key, and ADP already exposes that
    check over the run through ``GET /runs/{runId}/verify``, which Task 3.3
    gates on. What this establishes is the binding — that the envelope is about
    *this* snapshot, at *this* commit — which is the part a signature cannot
    supply and the part a caller can get wrong.
    """
    envelope = checkpoint.get("envelope")
    if not isinstance(envelope, dict):
        raise AttestationError("checkpoint carries no envelope")

    statement = decode_statement(envelope)
    if statement.get("predicateType") != CHECKPOINT_PREDICATE_TYPE:
        raise AttestationError(
            f"envelope is a {statement.get('predicateType')!r} attestation, "
            f"not {CHECKPOINT_PREDICATE_TYPE!r}"
        )

    predicate = statement.get("predicate")
    if not isinstance(predicate, dict):
        raise AttestationError("envelope statement has no predicate")

    attested = predicate.get("stateSha256")
    expected = state_digest(state)
    if attested != expected:
        raise AttestationError(
            f"envelope attests state {attested}, but the state sent digests to {expected}"
        )

    subjects = statement.get("subject") or []
    subject_sha = None
    if subjects and isinstance(subjects[0], dict):
        subject_sha = (subjects[0].get("digest") or {}).get("sha1")
    if git_sha is not None and subject_sha != git_sha:
        raise AttestationError(
            f"envelope attests commit {subject_sha}, not the {git_sha} it was taken at"
        )

    return CheckpointAttestation(
        git_sha=str(subject_sha),
        session_id=str(predicate.get("sessionId")),
        seq=int(predicate.get("seq", 0)),
        state_sha256=str(attested),
        trajectory_head=predicate.get("trajectoryHead"),
        event_count=predicate.get("eventCount"),
    )


def _reject_floats(value: Any) -> None:
    """Refuse a state carrying a float, before it becomes an unverifiable digest.

    Python and JavaScript do not agree on the decimal form of every double, so a
    float in the state is a digest that recomputes differently on the two sides
    for reasons no one will find quickly. Caught at the point of construction,
    where the fix is obvious.
    """
    if isinstance(value, float):
        raise AttestationError(
            "checkpoint state must not contain floats: Python and JavaScript do not "
            "agree on the decimal form of every double, which would make the attested "
            "digest unverifiable. Use a string or an integer."
        )
    if isinstance(value, dict):
        for item in value.values():
            _reject_floats(item)
    elif isinstance(value, list | tuple):
        for item in value:
            _reject_floats(item)
