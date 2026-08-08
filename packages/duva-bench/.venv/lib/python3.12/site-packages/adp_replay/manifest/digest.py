"""The self-certifying manifest digest (Task 0.1).

The digest is computed over a canonical form with the *storage identifiers*
removed. That is what "self-certifying" means here: a reader who is handed a
manifest file, with no access to the store it came out of and no idea which run
id it was filed under, can still recompute the digest and get the number the
publisher printed. A digest that covered the run id would instead certify "this
manifest, as filed here" — true, and useless to anyone downstream.

Canonicalization rules, all of them load-bearing:

* keys sorted at every depth, so serialization order cannot change the digest
* no insignificant whitespace
* UTF-8, not ASCII escapes, so the digest does not depend on the encoder's
  escaping policy
* datetimes normalized to UTC by the models before they reach here

Floats are emitted by Python's shortest round-trip repr, which is deterministic
for a given IEEE-754 double on every platform CPython supports. Manifests
therefore stay digest-stable across machines, which is the property Task 1.2
needs for snapshots and this module needs for everything else.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

# Paths removed before digesting, as explicit paths rather than by matching a
# field name anywhere it appears. Both entries name *where the manifest was
# stored*, and nothing else may be added here without the same justification:
# excluding a field from the digest is excluding it from what the digest
# attests, so this list is the whole of what a manifest does not certify.
DIGEST_EXCLUDED_PATHS: tuple[tuple[str, ...], ...] = (
    # This repo's own identifier for the run.
    ("run_id",),
    # ADP's identifier for the run it was recorded to. The binding's
    # `trajectory_digest` is *not* excluded: that is evidence about the run's
    # content, not about where it lives.
    ("adp", "run_id"),
)


def _strip(value: Any, paths: tuple[tuple[str, ...], ...]) -> Any:
    """Return ``value`` with each of ``paths`` removed, without mutating it."""
    if not isinstance(value, dict):
        return value

    here = {p[0] for p in paths if len(p) == 1}
    deeper: dict[str, list[tuple[str, ...]]] = {}
    for p in paths:
        if len(p) > 1:
            deeper.setdefault(p[0], []).append(p[1:])

    out: dict[str, Any] = {}
    for key, item in value.items():
        if key in here:
            continue
        if key in deeper:
            item = _strip(item, tuple(deeper[key]))
        out[key] = item
    return out


def canonical_form(payload: dict[str, Any]) -> dict[str, Any]:
    """The digested view of a manifest: its JSON form minus the storage ids."""
    stripped: dict[str, Any] = _strip(payload, DIGEST_EXCLUDED_PATHS)
    return stripped


def canonical_bytes(payload: dict[str, Any]) -> bytes:
    """Canonical JSON encoding of ``payload``, as digested."""
    return json.dumps(
        canonical_form(payload),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def digest_payload(payload: dict[str, Any]) -> str:
    """SHA-256 of the canonical form, prefixed the way ADP prefixes digests."""
    return "sha256:" + hashlib.sha256(canonical_bytes(payload)).hexdigest()
