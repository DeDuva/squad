"""Task corpus: closure auditing and the corpus file it produces.

Task 1.3 — Terminal Bench plugin and closure audit.
"""

from adp_replay.corpus.audit import (
    AUDIT_RATIO,
    CorpusAudit,
    FileRole,
    Finding,
    Hazard,
    Severity,
    TaskAudit,
    audit_task,
    audit_tasks,
    classify,
)
from adp_replay.corpus.terminal_bench import (
    CorpusBelowTarget,
    build_corpus,
    discover_tasks,
    render_corpus,
)

__all__ = [
    "AUDIT_RATIO",
    "CorpusAudit",
    "CorpusBelowTarget",
    "FileRole",
    "Finding",
    "Hazard",
    "Severity",
    "TaskAudit",
    "audit_task",
    "audit_tasks",
    "build_corpus",
    "classify",
    "discover_tasks",
    "render_corpus",
]
