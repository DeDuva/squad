"""Running the probe and reading Gate G0 (Task 0.3b).

The aggregation here is the registered one and nothing else: each task's median
over its own contexts first, then the median over tasks; `fork_at_zero` and
`fork_at_step` in separate cells, never pooled; and every in-scope cell must
clear the threshold, not the pool and not most of them.

The two-level median is not a detail. A trajectory with thirty resumable
prefixes and one with three would otherwise contribute in proportion to their
length, and the gate would report a fact about trajectory lengths — the same
reason Task 3.1 resamples over tasks and never over trajectories.
"""

from __future__ import annotations

import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from adp_replay.context.corpus import (
    PHASE0_CORPUS,
    CorpusTask,
    as_sourced_from,
    corpus_digest,
)
from adp_replay.context.fidelity import FidelityScore, score_translation
from adp_replay.context.providers import TRANSLATORS
from adp_replay.context.registered import (
    AMENDMENTS,
    BINDING_RECOVERABLE_IS_PRESERVED,
    G0_THRESHOLD,
    MINIMUM_PROVIDERS,
    REGISTERED_PROVIDERS,
    Capability,
)


class Grounding(StrEnum):
    """How far a reading was checked.

    The registered grounding check requires the rendered request to be accepted
    by the target provider's API. Until that has run, a reading measures what
    this repository's translator preserves, which is a weaker claim and is
    labelled as one everywhere it appears.
    """

    ROUND_TRIP_ONLY = "round_trip_only"
    PROVIDER_VERIFIED = "provider_verified"


@dataclass(frozen=True)
class TaskReading:
    """One task's contexts, under one ordered pair and one capability."""

    task_id: str
    scores: tuple[FidelityScore, ...]

    @property
    def median(self) -> float:
        return statistics.median(score.score for score in self.scores)


@dataclass(frozen=True)
class Cell:
    """An (ordered provider pair, capability) cell — the unit G0 is read over."""

    source: str
    target: str
    capability: Capability
    tasks: tuple[TaskReading, ...]
    grounding: Grounding = Grounding.ROUND_TRIP_ONLY

    @property
    def pair(self) -> str:
        return f"{self.source}->{self.target}"

    @property
    def median(self) -> float:
        return statistics.median(task.median for task in self.tasks)

    @property
    def iqr(self) -> tuple[float, float]:
        """The spread the plan asks for, reported beside the median."""
        medians = sorted(task.median for task in self.tasks)
        return (_quantile(medians, 0.25), _quantile(medians, 0.75))

    @property
    def context_count(self) -> int:
        return sum(len(task.scores) for task in self.tasks)

    @property
    def lost(self) -> Mapping[str, int]:
        """Which element types were dropped, and how often.

        The plan asks for the specific elements lost, not just the number. A
        cell that clears the bar while losing every reasoning trace is a
        different finding from one that clears it while losing nothing.
        """
        counts: dict[str, int] = {}
        for task in self.tasks:
            for score in task.scores:
                for name in score.lost:
                    counts[name] = counts.get(name, 0) + 1
        return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))

    @property
    def transformed(self) -> Mapping[str, int]:
        counts: dict[str, int] = {}
        for task in self.tasks:
            for score in task.scores:
                for name in score.transformed:
                    counts[name] = counts.get(name, 0) + 1
        return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))

    @property
    def passed(self) -> bool:
        return self.median >= G0_THRESHOLD


@dataclass(frozen=True)
class G0Report:
    """Every cell, and the single answer they add up to."""

    cells: tuple[Cell, ...]
    providers: tuple[str, ...]
    corpus_digest: str
    threshold: float = G0_THRESHOLD
    # The same cells read under the metric as it stood before the amendments.
    # The registration requires both to be printed: an amended threshold that
    # only ever showed its post-amendment numbers would be unfalsifiable.
    pre_amendment: tuple[Cell, ...] = ()

    @property
    def failing(self) -> tuple[Cell, ...]:
        return tuple(cell for cell in self.cells if not cell.passed)

    @property
    def passed(self) -> bool:
        return not self.failing

    @property
    def grounding(self) -> Grounding:
        # The weakest grounding of any cell. A report is only as checked as its
        # least-checked cell, and averaging that away is how a round-trip-only
        # reading gets quoted as a verified one.
        if any(cell.grounding is Grounding.ROUND_TRIP_ONLY for cell in self.cells):
            return Grounding.ROUND_TRIP_ONLY
        return Grounding.PROVIDER_VERIFIED

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate": "G0",
            "passed": self.passed,
            "threshold": self.threshold,
            "grounding": self.grounding.value,
            "providers": list(self.providers),
            "corpus_digest": self.corpus_digest,
            "amendments": list(AMENDMENTS),
            "pre_amendment_cells": [
                {
                    "source": cell.source,
                    "target": cell.target,
                    "capability": cell.capability.value,
                    "median": round(cell.median, 4),
                    "passed": cell.passed,
                }
                for cell in self.pre_amendment
            ],
            "cells": [
                {
                    "source": cell.source,
                    "target": cell.target,
                    "capability": cell.capability.value,
                    "median": round(cell.median, 4),
                    "iqr": [round(v, 4) for v in cell.iqr],
                    "tasks": len(cell.tasks),
                    "contexts": cell.context_count,
                    "passed": cell.passed,
                    "lost": dict(cell.lost),
                    "transformed": dict(cell.transformed),
                    "grounding": cell.grounding.value,
                }
                for cell in self.cells
            ],
        }

    def to_markdown(self) -> str:
        verdict = "PASS" if self.passed else "FAIL"
        lines = [
            "# Gate G0 — context fidelity",
            "",
            f"**{verdict}** — every in-scope cell must reach a median of {self.threshold}.",
            "",
            f"- Grounding: `{self.grounding.value}`",
            f"- Providers: {', '.join(self.providers)}",
            f"- Corpus: `{self.corpus_digest}`",
            "",
            "| pair | capability | median | IQR | tasks | contexts | verdict |",
            "|---|---|---|---|---|---|---|",
        ]
        for cell in self.cells:
            low, high = cell.iqr
            mark = "pass" if cell.passed else "**FAIL**"
            lines.append(
                f"| {cell.pair} | {cell.capability.value} | {cell.median:.3f} | "
                f"{low:.3f}-{high:.3f} | {len(cell.tasks)} | {cell.context_count} | {mark} |"
            )

        if self.pre_amendment:
            lines += [
                "",
                "## The same cells before the amendments",
                "",
                "Printed because an amended metric that only ever showed its post-amendment",
                "numbers could not be checked. Amendments in force: " + "; ".join(AMENDMENTS) + ".",
                "",
                "| pair | capability | before | after | moved |",
                "|---|---|---|---|---|",
            ]
            after = {(c.source, c.target, c.capability): c for c in self.cells}
            for cell in self.pre_amendment:
                now = after[(cell.source, cell.target, cell.capability)]
                delta = now.median - cell.median
                lines.append(
                    f"| {cell.pair} | {cell.capability.value} | {cell.median:.3f} | "
                    f"{now.median:.3f} | {delta:+.3f} |"
                )

        lines += ["", "## Elements lost, by cell", ""]
        for cell in self.cells:
            lost = cell.lost
            detail = ", ".join(f"{name} x{count}" for name, count in lost.items()) or "none"
            lines.append(f"- `{cell.pair}` / {cell.capability.value}: {detail}")

        if self.grounding is Grounding.ROUND_TRIP_ONLY:
            lines += [
                "",
                "> Round-trip only. These numbers say what this repository's translators "
                "preserve, not what the target providers accept. The registered grounding "
                "check — the rendered request must additionally be accepted by the target "
                "API — has not run.",
            ]
        return "\n".join(lines) + "\n"


def run_probe(
    tasks: Sequence[CorpusTask] = PHASE0_CORPUS,
    providers: Sequence[str] = REGISTERED_PROVIDERS,
) -> G0Report:
    """Score every ordered pair and capability over ``tasks``."""
    if len(providers) < MINIMUM_PROVIDERS:
        raise ValueError(
            f"provider scope narrowed below the registered floor of {MINIMUM_PROVIDERS}: "
            f"{list(providers)}"
        )
    unknown = set(providers) - set(TRANSLATORS)
    if unknown:
        raise ValueError(f"no translator for {sorted(unknown)}")

    cells: list[Cell] = []
    before: list[Cell] = []
    for source in providers:
        for target in providers:
            if source == target:
                continue
            for capability in Capability:
                cells.append(_cell(tasks, source, target, capability))
                if BINDING_RECOVERABLE_IS_PRESERVED:
                    before.append(_cell(tasks, source, target, capability, binding_carve_out=False))

    return G0Report(
        cells=tuple(cells),
        providers=tuple(providers),
        corpus_digest=corpus_digest(tasks),
        pre_amendment=tuple(before),
    )


def _cell(
    tasks: Sequence[CorpusTask],
    source: str,
    target: str,
    capability: Capability,
    *,
    binding_carve_out: bool = BINDING_RECOVERABLE_IS_PRESERVED,
) -> Cell:
    source_translator = TRANSLATORS[source]
    target_translator = TRANSLATORS[target]

    readings: list[TaskReading] = []
    for task in tasks:
        contexts = (
            (task.initial_context(),)
            if capability is Capability.FORK_AT_ZERO
            else task.step_contexts()
        )
        if not contexts:
            continue
        scores = tuple(
            score_translation(
                as_sourced_from(context, source_translator),
                target_translator,
                binding_carve_out=binding_carve_out,
            )
            for context in contexts
        )
        readings.append(TaskReading(task_id=task.task_id, scores=scores))

    return Cell(source=source, target=target, capability=capability, tasks=tuple(readings))


def _quantile(values: Sequence[float], q: float) -> float:
    """Linear-interpolated quantile, defined for the small n a task count gives.

    `statistics.quantiles` needs at least two points and cuts into n intervals;
    a corpus that has been narrowed to a handful of tasks would make it raise
    rather than report a spread.
    """
    if not values:
        return float("nan")
    if len(values) == 1:
        return values[0]
    position = q * (len(values) - 1)
    low = int(position)
    high = min(low + 1, len(values) - 1)
    return values[low] + (values[high] - values[low]) * (position - low)
