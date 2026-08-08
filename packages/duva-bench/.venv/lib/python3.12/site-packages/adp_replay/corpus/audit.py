"""Closure auditing for Terminal Bench tasks (Task 1.3).

A task is *closed* when running it twice, on two machines, at two different
times, can differ only because the model differed. Three things break that, and
the audit flags all three: **network use**, **background-process dependence**,
and **clock dependence**.

The distinction that makes this audit useful rather than a machine for rejecting
everything is **when** the hazard fires.

Network at *build* time is acceptable: the environment is pinned by image
digest (``EnvironmentSpec.image_digest``), so whatever `apt-get` fetched is
already inside the artifact every replay starts from. Network at *run* time is
not: it puts a third party's availability and current state inside the
measurement, and a replay six weeks later gets a different internet.

So findings carry a severity that depends on the file they were found in, and
only ``BLOCKING`` ones fail a task. Advisory findings are reported, not
suppressed — a corpus with a hundred advisory clock reads in its solutions is
telling you something even though every task passes.

**A flagged task is not a broken task.** It is a task this experiment cannot
interpret. The 1.25x audit ratio in Task 1.3 exists precisely because a
meaningful fraction of any real corpus will fail this and has to be replaced.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import NamedTuple

# Task 1.3: audit at least 1.25x the Task 0.4 target, to absorb attrition.
AUDIT_RATIO = 1.25


class Hazard(StrEnum):
    """What kind of closure a finding breaks."""

    NETWORK = "network"
    BACKGROUND_PROCESS = "background_process"
    CLOCK = "clock"


class Severity(StrEnum):
    """Whether a finding disqualifies the task."""

    BLOCKING = "blocking"
    ADVISORY = "advisory"


class FileRole(StrEnum):
    """When in a task's life a file runs.

    The whole severity policy turns on this, so it is a first-class thing rather
    than a guess made at the point of matching.
    """

    BUILD = "build"
    TEST = "test"
    SOLUTION = "solution"
    STATEMENT = "statement"
    RUNTIME = "runtime"


@dataclass(frozen=True)
class Finding:
    """One hazard, with enough evidence to check it by hand."""

    hazard: Hazard
    severity: Severity
    path: str
    line: int
    text: str
    pattern: str
    note: str


class Rule(NamedTuple):
    hazard: Hazard
    pattern: re.Pattern[str]
    note: str


# Patterns are deliberately narrow and word-anchored. A closure audit that
# over-matches gets ignored, and an ignored audit is worse than none: it makes
# the corpus look examined.
RULES: tuple[Rule, ...] = (
    Rule(
        Hazard.NETWORK,
        re.compile(r"\b(curl|wget|nc|netcat|ping|dig|nslookup|ssh|scp|rsync|telnet)\b"),
        "reaches the network at run time",
    ),
    Rule(
        Hazard.NETWORK,
        re.compile(r"\b(apt-get|apt|yum|dnf|apk|brew)\s+(install|update|upgrade|add)\b"),
        "installs packages, which needs a package mirror",
    ),
    Rule(
        Hazard.NETWORK,
        re.compile(r"\b(pip3?|uv|npm|yarn|pnpm|cargo|go)\s+(install|add|get|fetch)\b"),
        "installs dependencies, which needs a registry",
    ),
    Rule(
        Hazard.NETWORK,
        re.compile(r"\bgit\s+(clone|fetch|pull|remote|push)\b"),
        "talks to a git remote",
    ),
    Rule(
        Hazard.NETWORK,
        re.compile(r"\b(requests\.(get|post|put|delete|head)|urllib|httpx\.|aiohttp|socket\.)"),
        "opens a connection from code",
    ),
    Rule(
        Hazard.NETWORK,
        re.compile(r"https?://(?!localhost|127\.0\.0\.1|0\.0\.0\.0)"),
        "names a remote URL",
    ),
    Rule(
        Hazard.BACKGROUND_PROCESS,
        re.compile(r"\b(nohup|setsid|disown|supervisord|supervisorctl)\b"),
        "detaches a process from the run",
    ),
    Rule(
        Hazard.BACKGROUND_PROCESS,
        re.compile(r"\b(systemctl|service)\s+\w*\s*(start|restart|enable)\b"),
        "depends on a service being brought up",
    ),
    Rule(
        Hazard.BACKGROUND_PROCESS,
        re.compile(r"\b(screen|tmux)\s+(new|new-session|-d)\b"),
        "runs work in a detached terminal multiplexer",
    ),
    Rule(
        Hazard.BACKGROUND_PROCESS,
        re.compile(r"\bdocker\s+(run|compose\s+up)\b.*\s-d\b"),
        "starts a detached container",
    ),
    Rule(
        Hazard.BACKGROUND_PROCESS,
        re.compile(r"&\s*$"),
        "backgrounds a command, so what follows races it",
    ),
    Rule(
        Hazard.BACKGROUND_PROCESS,
        re.compile(r"\b(Popen|subprocess\.Popen|multiprocessing\.Process|threading\.Thread)\b"),
        "spawns a process or thread the harness does not wait on",
    ),
    Rule(
        Hazard.CLOCK,
        re.compile(r"\bsleep\b|\btime\.sleep\b"),
        "waits on wall-clock time, which is a timing assumption",
    ),
    Rule(
        Hazard.CLOCK,
        re.compile(r"\b(time\.time|time\.monotonic|perf_counter|datetime\.now|datetime\.utcnow)\b"),
        "reads the clock",
    ),
    Rule(
        Hazard.CLOCK,
        re.compile(r"\b(date|cron|crontab|at)\b\s*(\+|-|\"|')"),
        "formats or schedules against the current date",
    ),
    Rule(
        Hazard.CLOCK,
        re.compile(r"\bstrftime\b|%Y-%m-%d"),
        "formats the current date",
    ),
    Rule(
        Hazard.CLOCK,
        re.compile(r"\btimeout\s+\d"),
        "bounds a command by wall-clock time",
    ),
)

# Severity by (hazard, role). Anything not named here is advisory.
#
# Build-time network is advisory because the image is pinned by digest: what it
# fetched is inside the artifact every replay starts from. Everything at run
# time is blocking, because it puts something outside the container inside the
# measurement.
#
# A clock read in a *test* is blocking and one in a *solution* is not, because
# the test decides pass or fail. A solution that looks at the clock produces a
# different trajectory; a test that looks at the clock produces a different
# verdict for the same trajectory, which is the thing that makes a result
# uninterpretable.
BLOCKING: frozenset[tuple[Hazard, FileRole]] = frozenset(
    {
        (Hazard.NETWORK, FileRole.TEST),
        (Hazard.NETWORK, FileRole.SOLUTION),
        (Hazard.NETWORK, FileRole.RUNTIME),
        (Hazard.BACKGROUND_PROCESS, FileRole.TEST),
        (Hazard.BACKGROUND_PROCESS, FileRole.SOLUTION),
        (Hazard.BACKGROUND_PROCESS, FileRole.RUNTIME),
        (Hazard.CLOCK, FileRole.TEST),
    }
)

_BUILD_NAMES = {"dockerfile", "containerfile", "docker-compose.yaml", "docker-compose.yml"}
_STATEMENT_NAMES = {"task.yaml", "task.yml", "task.toml", "task.json", "instruction.md"}
_TEXT_SUFFIXES = {".sh", ".bash", ".py", ".yaml", ".yml", ".toml", ".json", ".md", ".txt", ""}


def classify(relative: Path) -> FileRole:
    """Which role a file plays, from its path.

    Terminal Bench's layout is a convention rather than a schema, so this
    matches loosely and errs towards ``RUNTIME`` — the strictest role — when a
    file's purpose is not obvious. Guessing ``BUILD`` for an unknown file would
    quietly downgrade a blocking finding to advisory.
    """
    name = relative.name.lower()
    parts = {part.lower() for part in relative.parts}

    if name in _BUILD_NAMES:
        return FileRole.BUILD
    if name in _STATEMENT_NAMES:
        return FileRole.STATEMENT
    if "tests" in parts or name.startswith("test") or name.endswith(("_test.py", "-tests.sh")):
        return FileRole.TEST
    if name.startswith("solution") or "solution" in parts:
        return FileRole.SOLUTION
    return FileRole.RUNTIME


def severity_for(hazard: Hazard, role: FileRole) -> Severity:
    return Severity.BLOCKING if (hazard, role) in BLOCKING else Severity.ADVISORY


@dataclass(frozen=True)
class TaskAudit:
    """One task's verdict, and everything the audit saw."""

    task_id: str
    findings: tuple[Finding, ...] = ()
    files: tuple[str, ...] = ()

    @property
    def blocking(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.severity is Severity.BLOCKING)

    @property
    def advisory(self) -> tuple[Finding, ...]:
        return tuple(f for f in self.findings if f.severity is Severity.ADVISORY)

    @property
    def passed(self) -> bool:
        """Closed enough to interpret a replay on."""
        return not self.blocking

    @property
    def hazards(self) -> tuple[str, ...]:
        return tuple(sorted({f.hazard.value for f in self.blocking}))


@dataclass(frozen=True)
class CorpusAudit:
    """Every task audited, against the size Task 0.4 asked for."""

    audits: tuple[TaskAudit, ...]
    target_tasks: int

    @property
    def audit_target(self) -> int:
        """At least 1.25x the target, to absorb attrition."""
        import math

        return math.ceil(self.target_tasks * AUDIT_RATIO)

    @property
    def passing(self) -> tuple[TaskAudit, ...]:
        return tuple(audit for audit in self.audits if audit.passed)

    @property
    def audited_enough(self) -> bool:
        return len(self.audits) >= self.audit_target

    @property
    def meets_target(self) -> bool:
        """Task 1.3's done-condition: the passing corpus reaches the target."""
        return len(self.passing) >= self.target_tasks

    @property
    def attrition(self) -> float:
        if not self.audits:
            return 0.0
        return 1.0 - len(self.passing) / len(self.audits)


def audit_task(root: Path, task_id: str | None = None) -> TaskAudit:
    """Audit one task directory for closure."""
    base = Path(root)
    identifier = task_id or base.name

    findings: list[Finding] = []
    files: list[str] = []
    for path in sorted(base.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        if path.suffix.lower() not in _TEXT_SUFFIXES:
            continue

        relative = path.relative_to(base)
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

        files.append(relative.as_posix())
        findings.extend(_scan(content, relative))

    return TaskAudit(task_id=identifier, findings=tuple(findings), files=tuple(files))


def _scan(content: str, relative: Path) -> list[Finding]:
    role = classify(relative)
    findings: list[Finding] = []

    for number, raw in enumerate(content.splitlines(), start=1):
        line = raw.strip()
        # A commented-out curl is not a hazard, and flagging one trains people
        # to ignore the audit.
        if not line or line.startswith("#"):
            continue

        for rule in RULES:
            match = rule.pattern.search(line)
            if match is None:
                continue
            findings.append(
                Finding(
                    hazard=rule.hazard,
                    severity=severity_for(rule.hazard, role),
                    path=relative.as_posix(),
                    line=number,
                    text=line[:200],
                    pattern=rule.pattern.pattern,
                    note=rule.note,
                )
            )
    return findings


def audit_tasks(roots: list[Path], target_tasks: int) -> CorpusAudit:
    """Audit every task directory, against the Task 0.4 target."""
    return CorpusAudit(
        audits=tuple(audit_task(root) for root in sorted(roots)),
        target_tasks=target_tasks,
    )
