"""Content-addressed store (Task 1.1).

Snapshot bytes stay local. They are attested to ADP by digest through a session
checkpoint, whose response is a signed DSSE envelope binding the commit to a
SHA-256 digest of the checkpoint state. That gives attested provenance without
pushing multi-megabyte tarballs through a JSON API.

A remote CAS backend is post-MVP.

Two properties this store keeps that a plain directory would not:

*The digest is of the content, never of the stored bytes.* Objects are gzipped
on disk, and the digest covers what went in rather than what landed. Compression
output is not stable across zlib versions, so addressing the compressed form
would make "the same tree on two machines yields the same digest" — the Task 1.2
done-condition — depend on which zlib each machine happens to ship.

*Reads are verified.* :meth:`LocalCAStore.get` recomputes the digest of what it
decompressed and refuses to hand back anything that does not match. A store that
returns bytes without checking them is a directory with extra steps, and silent
corruption in a snapshot is a replay that diverges for a reason nobody can find.
"""

from __future__ import annotations

import gzip
import hashlib
import os
import tempfile
from pathlib import Path
from typing import Protocol

DIGEST_PREFIX = "sha256:"


class CorruptObject(RuntimeError):
    """Stored bytes do not hash to the digest they were filed under."""


def digest_of(data: bytes) -> str:
    """The digest this store addresses ``data`` by."""
    return DIGEST_PREFIX + hashlib.sha256(data).hexdigest()


class CAStore(Protocol):
    """A store addressed by the SHA-256 of its contents."""

    def put(self, data: bytes) -> str:
        """Store ``data`` and return its digest."""
        ...

    def get(self, digest: str) -> bytes:
        """Return the bytes previously stored under ``digest``."""
        ...

    def has(self, digest: str) -> bool:
        """Whether ``digest`` is present, without reading it back."""
        ...


class LocalCAStore:
    """The MVP backend: a directory of digest-named files."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def put(self, data: bytes) -> str:
        digest = digest_of(data)
        path = self._path(digest)
        if path.exists():
            # Already stored, and the name is the checksum, so there is nothing
            # a rewrite could correct.
            return digest

        path.parent.mkdir(parents=True, exist_ok=True)
        # Written under a temporary name in the same directory and renamed, so a
        # crash mid-write leaves no half-object filed under a digest that
        # promises a whole one. gzip's mtime is pinned so the bytes on disk are
        # reproducible too, even though nothing depends on that.
        handle, temporary = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with (
                os.fdopen(handle, "wb") as raw,
                gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed,
            ):
                compressed.write(data)
            os.replace(temporary, path)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
        return digest

    def get(self, digest: str) -> bytes:
        path = self._path(digest)
        if not path.exists():
            raise KeyError(digest)

        with gzip.open(path, "rb") as compressed:
            data = compressed.read()

        actual = digest_of(data)
        if actual != digest:
            raise CorruptObject(f"{digest} decompressed to {actual}")
        return data

    def has(self, digest: str) -> bool:
        return self._path(digest).exists()

    def _path(self, digest: str) -> Path:
        if not digest.startswith(DIGEST_PREFIX):
            raise ValueError(f"{digest!r} is not a {DIGEST_PREFIX} digest")
        hexdigest = digest.removeprefix(DIGEST_PREFIX)
        if len(hexdigest) != 64 or not all(c in "0123456789abcdef" for c in hexdigest):
            raise ValueError(f"{digest!r} is not a SHA-256 digest")
        # Sharded two levels: a flat directory of a hundred thousand snapshots is
        # slow to list on every filesystem worth naming.
        return self.root / hexdigest[:2] / hexdigest[2:4] / f"{hexdigest}.gz"
