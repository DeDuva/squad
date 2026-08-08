"""Trajectory recording.

Task 1.4 — recorder (Inspect solver wrapper) and its local spool.
Task 1.5 — overhead benchmark.
"""

from adp_replay.recording.benchmark import (
    G1_THRESHOLD,
    REFERENCE_STEP_SECONDS,
    BenchmarkReport,
    Measurement,
    benchmark,
)
from adp_replay.recording.inspect_solver import RecordingSolver, StateDelta, inspect_solver
from adp_replay.recording.recorder import Recorder, RecorderStats, RecorderStopped
from adp_replay.recording.spool import Spool, SpoolCorrupt

__all__ = [
    "G1_THRESHOLD",
    "REFERENCE_STEP_SECONDS",
    "BenchmarkReport",
    "Measurement",
    "Recorder",
    "RecorderStats",
    "RecorderStopped",
    "RecordingSolver",
    "Spool",
    "SpoolCorrupt",
    "StateDelta",
    "benchmark",
    "inspect_solver",
]
