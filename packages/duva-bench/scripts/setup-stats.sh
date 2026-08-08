#!/usr/bin/env bash
# Build the venv duva-bench's statistics run in.
#
# The stats live in adp-replay's Python library, shared by both duva-bench
# tracks so a divergence between them cannot be a difference in method. This
# script installs that library, pinned by commit, into a venv inside the
# package — so the analysis is reproducible from a fresh clone rather than
# depending on a sibling working copy someone happens to have.
#
# Idempotent. Safe to re-run; pass --force to rebuild from scratch.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
venv="$here/.venv"
requirements="$here/requirements-stats.txt"

# Which interpreter builds the venv. `python3` is not assumed: on the machine
# this was developed against, the system Python is 3.14 with no `ensurepip`, so
# `python3 -m venv` fails and the fix needs `sudo apt`. A uv-managed CPython
# with a working pip is used instead when present. CI, which has an ordinary
# Python, needs no override.
pick_python() {
  if [ -n "${DUVA_BENCH_BASE_PYTHON:-}" ]; then
    echo "$DUVA_BENCH_BASE_PYTHON"; return
  fi
  for candidate in \
    "$HOME/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12" \
    "$(command -v python3.12 || true)" \
    "$(command -v python3 || true)"
  do
    [ -n "$candidate" ] || continue
    [ -x "$candidate" ] || continue
    # A venv is only buildable if ensurepip is there; check rather than discover
    # it halfway through with a half-made venv on disk.
    if "$candidate" -c 'import ensurepip' >/dev/null 2>&1; then
      echo "$candidate"; return
    fi
  done
  echo ""
}

if [ "${1:-}" = "--force" ]; then
  rm -rf "$venv"
fi

if [ ! -x "$venv/bin/python" ]; then
  base="$(pick_python)"
  if [ -z "$base" ]; then
    echo "No Python that can create a venv (needs ensurepip)." >&2
    echo "Set DUVA_BENCH_BASE_PYTHON to one, or install your distro's python3-venv." >&2
    exit 1
  fi
  echo "Creating $venv with $base"
  "$base" -m venv "$venv"
fi

"$venv/bin/python" -m pip install --quiet --disable-pip-version-check --upgrade pip
"$venv/bin/python" -m pip install --quiet --disable-pip-version-check -r "$requirements"

"$venv/bin/python" - <<'PY'
from adp_replay.stats.paired import mcnemar_exact  # noqa: F401
import adp_replay
print(f"adp_replay {getattr(adp_replay, '__version__', 'unknown')} — stats importable")
PY

echo "Done. duva-bench will find this venv automatically; override with DUVA_BENCH_PYTHON."
