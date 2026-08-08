"""Discovering Terminal Bench tasks and producing ``tb2_closed_corpus.json``.

Task 1.3's done-condition is that the audited, passing corpus **meets or exceeds
the Task 0.4 target**. That is enforced here rather than checked by eye:
:func:`build_corpus` refuses to write a corpus that claims to be usable while
falling short, because the one thing a corpus file must never do is understate
how much attrition it absorbed.

The target is not a constant in this module. It comes from Task 0.4, which is
the whole point of running the power analysis first — a corpus size fixed before
the power analysis reports is a number someone made up.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from adp_replay.corpus.audit import AUDIT_RATIO, CorpusAudit, TaskAudit, audit_tasks

SCHEMA_VERSION = "0.1.0"

# What makes a directory a task rather than a directory. Terminal Bench's layout
# is a convention, so this asks for the two things every task has: something
# that states the task, and something that builds its world.
TASK_MARKERS = ("task.yaml", "task.yml", "task.toml", "task.json")
BUILD_MARKERS = ("Dockerfile", "Containerfile", "docker-compose.yaml", "docker-compose.yml")


class CorpusBelowTarget(RuntimeError):
    """The passing corpus is smaller than the experiment needs.

    Carries the audit, because the summary is worth reading precisely when the
    corpus is short — that is when "which hazard cost me the most tasks" is the
    question.
    """

    def __init__(self, message: str, audit: CorpusAudit) -> None:
        super().__init__(message)
        self.audit = audit


def discover_tasks(root: Path) -> list[Path]:
    """Every task directory under ``root``.

    A directory qualifies when it holds a task statement *and* something that
    builds an environment. Requiring both keeps fixtures, templates, and shared
    helper directories out of a corpus count that the experiment's power depends
    on.
    """
    base = Path(root)
    found: list[Path] = []
    for candidate in sorted(p for p in base.rglob("*") if p.is_dir()):
        names = {child.name for child in candidate.iterdir() if child.is_file()}
        if any(marker in names for marker in TASK_MARKERS) and any(
            marker in names for marker in BUILD_MARKERS
        ):
            found.append(candidate)
    return found


def render_corpus(audit: CorpusAudit, *, source: str | None = None) -> dict[str, Any]:
    """The ``tb2_closed_corpus.json`` document.

    Carries the failing tasks as well as the passing ones. A corpus file that
    listed only what survived would hide its own selection: the interesting
    question about a closed corpus is always what had to be thrown away, and why.
    """
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(UTC).isoformat(),
        "source": source,
        "target_tasks": audit.target_tasks,
        "audit_ratio": AUDIT_RATIO,
        "audit_target": audit.audit_target,
        "audited": len(audit.audits),
        "passing": len(audit.passing),
        "audited_enough": audit.audited_enough,
        "meets_target": audit.meets_target,
        "attrition": round(audit.attrition, 4),
        "tasks": [_task(task) for task in audit.audits],
    }


def _task(audit: TaskAudit) -> dict[str, Any]:
    return {
        "task_id": audit.task_id,
        "passed": audit.passed,
        "blocking_hazards": list(audit.hazards),
        "files": list(audit.files),
        "findings": [
            {
                "hazard": finding.hazard.value,
                "severity": finding.severity.value,
                "path": finding.path,
                "line": finding.line,
                "text": finding.text,
                "pattern": finding.pattern,
                "note": finding.note,
            }
            for finding in audit.findings
        ],
    }


def build_corpus(
    roots: Sequence[Path],
    *,
    target_tasks: int,
    out: Path | None = None,
    allow_short: bool = False,
    source: str | None = None,
) -> CorpusAudit:
    """Audit ``roots`` and write the corpus file.

    Raises :class:`CorpusBelowTarget` when the passing corpus falls short of
    ``target_tasks``. ``allow_short`` writes it anyway — for looking at an
    audit in progress — and the document still records ``meets_target: false``,
    so a short corpus can be inspected but never mistaken for a finished one.
    """
    audit = audit_tasks(list(roots), target_tasks)

    if out is not None and (audit.meets_target or allow_short):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(render_corpus(audit, source=source), indent=2) + "\n", encoding="utf-8"
        )

    if not audit.meets_target and not allow_short:
        raise CorpusBelowTarget(
            f"{len(audit.passing)} of {len(audit.audits)} audited tasks are closed, and the "
            f"experiment needs {audit.target_tasks} (Task 0.4). "
            f"Audit at least {audit.audit_target} tasks — {AUDIT_RATIO}x the target — to "
            f"absorb the {audit.attrition:.0%} attrition seen here.",
            audit,
        )
    return audit


def render_markdown(audit: CorpusAudit) -> str:
    """A human-readable audit summary."""
    lines = [
        "# Task 1.3 — closure audit",
        "",
        f"**{len(audit.passing)} of {len(audit.audits)} audited tasks are closed.** "
        f"The experiment needs {audit.target_tasks} (Task 0.4); "
        f"{audit.audit_target} should be audited to absorb attrition.",
        "",
        f"- Audited enough: {'yes' if audit.audited_enough else 'no'}",
        f"- Meets target: {'yes' if audit.meets_target else 'NO'}",
        f"- Attrition: {audit.attrition:.1%}",
        "",
        "## Why tasks were rejected",
        "",
    ]

    counts: dict[str, int] = {}
    for task in audit.audits:
        for hazard in task.hazards:
            counts[hazard] = counts.get(hazard, 0) + 1

    if counts:
        lines += ["| hazard | tasks blocked |", "|---|---|"]
        lines += [
            f"| {hazard} | {count} |"
            for hazard, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ]
    else:
        lines.append("No task was blocked.")

    return "\n".join(lines) + "\n"
