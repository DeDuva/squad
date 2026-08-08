"""Content-addressed storage for state snapshots.

Task 1.1 — CAStore protocol and LocalCAStore.
Task 1.2 — filesystem-delta capture.
"""

from adp_replay.storage.attest import (
    AttestationError,
    CheckpointAttestation,
    snapshot_state,
    state_digest,
    verify_checkpoint,
)
from adp_replay.storage.capture import (
    Capture,
    CaptureOptions,
    capture_tree,
    restore_tree,
    tree_digest,
)
from adp_replay.storage.castore import CAStore, CorruptObject, LocalCAStore, digest_of

__all__ = [
    "AttestationError",
    "CAStore",
    "Capture",
    "CaptureOptions",
    "CheckpointAttestation",
    "CorruptObject",
    "LocalCAStore",
    "capture_tree",
    "digest_of",
    "restore_tree",
    "snapshot_state",
    "state_digest",
    "tree_digest",
    "verify_checkpoint",
]
