"""Filesystem-delta capture (Task 1.2).

Tarball snapshots before and after tool execution, normalized so that digests
are content-determined and reproducible across machines. The done-condition is
literal: capturing the same tree twice on two machines yields identical digests.

Everything a filesystem records that is not content has to go, because all of it
varies between machines and none of it is what the agent saw:

* **mtimes** are zeroed. They differ by checkout time on every machine.
* **uid, gid, and their names** are zeroed. They differ by whoever ran the task.
* **modes** collapse to executable-or-not. A umask is a property of the shell
  that made the file, not of the file.
* **entry order** is sorted. Directory order is filesystem order, which is not
  even stable between two reads on the same machine.
* **the tar format is GNU**, not PAX. PAX writes extended headers carrying
  sub-second timestamps, which is precisely the nondeterminism being removed.

What is deliberately *not* captured is anything outside the filesystem —
processes, sockets, kernel state — which is why every manifest has to declare
:data:`~adp_replay.manifest.StateCompleteness.FILESYSTEM` and every report
reprints it. A capture that quietly skipped a socket while claiming a complete
snapshot would be the single most misleading thing this repository could do, so
skipped entries are collected and returned rather than dropped.

``.git`` is excluded by default. Git objects embed committer timestamps and pack
files that differ between machines holding identical history, so including them
would break reproducibility for content that ADP already attests better: the
checkpoint binds a commit sha, and ADP is the git host. The working tree is what
this captures; the history is what ADP has.
"""

from __future__ import annotations

import io
import stat
import tarfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from adp_replay.storage.castore import digest_of

# A file is either executable or it is not. Everything else about a mode is the
# umask of whichever shell created it.
FILE_MODE = 0o644
EXECUTABLE_MODE = 0o755
DIRECTORY_MODE = 0o755


@dataclass(frozen=True)
class CaptureOptions:
    """What to capture, and what to leave out."""

    # Matched against each entry's path relative to the root, and against each
    # individual path segment, so ".git" excludes it at any depth.
    exclude: tuple[str, ...] = (".git",)
    # Symlinks are stored as symlinks. Following them would duplicate content,
    # and a link pointing outside the tree would silently pull in the machine.
    follow_symlinks: bool = False


@dataclass(frozen=True)
class Capture:
    """A snapshot, its digest, and an honest account of what it left out."""

    data: bytes
    digest: str
    entries: tuple[str, ...] = ()
    # Sockets, FIFOs, devices: present in the tree, outside what v0 captures.
    # Returned rather than dropped, so a caller can refuse to claim a complete
    # snapshot of a tree that contained one.
    skipped: tuple[str, ...] = field(default_factory=tuple)

    @property
    def is_complete_for_filesystem(self) -> bool:
        """Whether every entry in the tree was of a kind v0 captures."""
        return not self.skipped


def _excluded(relative: PurePosixPath, options: CaptureOptions) -> bool:
    text = relative.as_posix()
    return any(pattern == text or pattern in relative.parts for pattern in options.exclude)


def capture_tree(root: Path, options: CaptureOptions | None = None) -> Capture:
    """Snapshot ``root`` into deterministic tar bytes."""
    settings = options or CaptureOptions()
    base = Path(root).resolve()
    if not base.is_dir():
        raise NotADirectoryError(base)

    entries: list[str] = []
    skipped: list[str] = []
    buffer = io.BytesIO()

    # GNU format, no compression: the digest covers the tar, and the store
    # compresses it. Compression is not byte-stable across zlib versions, and
    # this digest has to be.
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.GNU_FORMAT) as archive:
        for path in _walk(base, settings):
            relative = PurePosixPath(path.relative_to(base).as_posix())
            info = _entry(path, relative)
            if info is None:
                skipped.append(relative.as_posix())
                continue

            entries.append(relative.as_posix())
            if info.isreg():
                with path.open("rb") as handle:
                    archive.addfile(info, handle)
            else:
                archive.addfile(info)

    data = buffer.getvalue()
    return Capture(
        data=data,
        digest=digest_of(data),
        entries=tuple(entries),
        skipped=tuple(skipped),
    )


def _walk(base: Path, options: CaptureOptions) -> list[Path]:
    """Every path under ``base``, in a sorted, stable order.

    Sorted by the posix relative path rather than by whatever order the
    filesystem hands back, which is not stable even between two reads.
    """
    found: list[Path] = []

    def descend(directory: Path) -> None:
        for child in sorted(directory.iterdir(), key=lambda p: p.name):
            relative = PurePosixPath(child.relative_to(base).as_posix())
            if _excluded(relative, options):
                continue
            found.append(child)
            # is_dir() follows symlinks; a symlink to a directory is stored as
            # the link, not walked into, or a link to "/" captures the machine.
            if child.is_dir() and not child.is_symlink():
                descend(child)

    descend(base)
    return sorted(found, key=lambda p: p.relative_to(base).as_posix())


def _entry(path: Path, relative: PurePosixPath) -> tarfile.TarInfo | None:
    """A fully normalized TarInfo, or None for a kind v0 does not capture."""
    info = tarfile.TarInfo(name=relative.as_posix())
    stats = path.lstat()

    if path.is_symlink():
        info.type = tarfile.SYMTYPE
        info.linkname = str(path.readlink())
        info.mode = FILE_MODE
    elif stat.S_ISDIR(stats.st_mode):
        info.type = tarfile.DIRTYPE
        info.mode = DIRECTORY_MODE
    elif stat.S_ISREG(stats.st_mode):
        info.type = tarfile.REGTYPE
        info.size = stats.st_size
        info.mode = EXECUTABLE_MODE if stats.st_mode & stat.S_IXUSR else FILE_MODE
    else:
        # A socket, FIFO, or device node. Out of scope for v0, and the caller
        # is told rather than left to assume.
        return None

    # Everything below is the normalization the done-condition depends on.
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    return info


def restore_tree(data: bytes, destination: Path) -> None:
    """Materialize a captured tree.

    Extracted with tar's ``data`` filter, which refuses absolute paths, parent
    traversal, and anything that is not a plain file, directory, or symlink. A
    snapshot is untrusted input the moment it comes back off disk, and a replay
    that let one write outside its own workspace would be a worse problem than
    any it was built to study.
    """
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        archive.extractall(destination, filter="data")


def tree_digest(root: Path, options: CaptureOptions | None = None) -> str:
    """The digest of ``root``'s snapshot, without keeping the bytes."""
    return capture_tree(root, options).digest
