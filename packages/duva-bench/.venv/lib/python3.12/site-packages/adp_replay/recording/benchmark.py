"""Overhead benchmark and Gate G1 (Task 1.5).

Measures wall-clock overhead against an unrecorded baseline, **inclusive of ADP
round-trips**. The plan is explicit that the budget covers the real system rather
than the recorder in isolation, so the recorded arm here talks to a real ADP and
the flush thread's work counts against it.

One thing has to be said before any number is quoted: **overhead as a percentage
is not a property of the recorder alone.** It is the recorder's cost divided by
how long a step takes, and steps in an agentic run vary from a few milliseconds
to tens of seconds. Quoting a single percentage without the step duration it was
measured at is quoting half a fraction.

So this reports a curve across step durations as well as a headline number at a
declared reference duration, the same discipline the power analysis uses for its
assumptions. The headline is the one G1 is read against; the curve is what says
whether the headline is robust or an artifact of one choice.

The recorded arm does exactly what a real run does: spool an event per step,
flush asynchronously in batches, and close — including the final flush, because
a recorder that abandoned its tail would look fast by not doing its job.
"""

from __future__ import annotations

import statistics
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

# What a step costs when it is not being recorded. An agentic step is dominated
# by a model call and a tool execution; 250ms is a deliberately conservative
# stand-in, because a *shorter* step makes recording look worse, and G1 should be
# read against a number that does not flatter it.
REFERENCE_STEP_SECONDS = 0.25

# The registered pass mark.
G1_THRESHOLD = 0.10


@dataclass(frozen=True)
class Measurement:
    """One (step duration) point: baseline, recorded, and the ratio."""

    step_seconds: float
    steps: int
    baseline_seconds: float
    recorded_seconds: float

    @property
    def overhead(self) -> float:
        """Fractional wall-clock overhead. 0.10 is the G1 budget."""
        if self.baseline_seconds <= 0:
            return float("inf")
        return (self.recorded_seconds - self.baseline_seconds) / self.baseline_seconds

    @property
    def passes(self) -> bool:
        return self.overhead <= G1_THRESHOLD


@dataclass(frozen=True)
class BenchmarkReport:
    """Every point measured, and the single answer G1 is read against."""

    measurements: tuple[Measurement, ...]
    reference_step_seconds: float = REFERENCE_STEP_SECONDS
    trials: int = 1
    inclusive_of_adp: bool = True
    notes: dict[str, Any] = field(default_factory=dict)

    @property
    def reference(self) -> Measurement | None:
        """The measurement at the declared reference step duration."""
        for measurement in self.measurements:
            if measurement.step_seconds == self.reference_step_seconds:
                return measurement
        return None

    @property
    def median_overhead(self) -> float:
        """Median across the measured points.

        The plan says *median* recording overhead, so that is what is reported,
        rather than the best point or the mean — a mean would let one very slow
        step duration hide a bad result at fast ones.
        """
        if not self.measurements:
            return float("nan")
        return statistics.median(m.overhead for m in self.measurements)

    @property
    def passes(self) -> bool:
        """G1: median recording overhead ≤ 10%, inclusive of ADP round-trips."""
        reference = self.reference
        if reference is not None and not reference.passes:
            # A pass at the median that fails at the declared reference is not a
            # pass. The reference is the duration the gate was meant to be read
            # at; letting the median override it would make the choice of
            # sampled durations the thing that decides the gate.
            return False
        return self.median_overhead <= G1_THRESHOLD

    def to_dict(self) -> dict[str, Any]:
        return {
            "gate": "G1",
            "passed": self.passes,
            "threshold": G1_THRESHOLD,
            "inclusive_of_adp_round_trips": self.inclusive_of_adp,
            "reference_step_seconds": self.reference_step_seconds,
            "trials": self.trials,
            "median_overhead": round(self.median_overhead, 4),
            "reference_overhead": (
                None if self.reference is None else round(self.reference.overhead, 4)
            ),
            "measurements": [
                {
                    "step_seconds": m.step_seconds,
                    "steps": m.steps,
                    "baseline_seconds": round(m.baseline_seconds, 4),
                    "recorded_seconds": round(m.recorded_seconds, 4),
                    "overhead": round(m.overhead, 4),
                    "passes": m.passes,
                }
                for m in self.measurements
            ],
        }

    def to_markdown(self) -> str:
        verdict = "PASS" if self.passes else "FAIL"
        lines = [
            "# Gate G1 — recording overhead",
            "",
            f"**{verdict}** — median overhead {self.median_overhead:.1%} against a "
            f"{G1_THRESHOLD:.0%} budget, inclusive of ADP round-trips.",
            "",
            f"Reference step duration: {self.reference_step_seconds}s. "
            f"{self.trials} trial(s) per point, best-of taken to suppress scheduler noise.",
            "",
            "Overhead is the recorder's cost divided by how long a step takes, so a single",
            "percentage means nothing without the step duration beside it. The curve is what",
            "says whether the headline is robust or an artifact of one choice.",
            "",
            "| step | steps | baseline | recorded | overhead | |",
            "|---|---|---|---|---|---|",
        ]
        for m in self.measurements:
            mark = "pass" if m.passes else "**over**"
            lines.append(
                f"| {m.step_seconds}s | {m.steps} | {m.baseline_seconds:.3f}s | "
                f"{m.recorded_seconds:.3f}s | {m.overhead:+.1%} | {mark} |"
            )
        return "\n".join(lines) + "\n"


def measure(
    *,
    step_seconds: float,
    steps: int,
    record: Callable[[int], None] | None,
    finish: Callable[[], None] | None = None,
    work: Callable[[float], None] = time.sleep,
) -> float:
    """Time a synthetic run of ``steps`` steps, recording if given a recorder.

    ``finish`` is included in the measurement. A recorder that skipped its final
    flush would look fast by not finishing its job, and the tail of a run is
    where the events that say how it ended live.
    """
    started = time.perf_counter()
    for index in range(steps):
        work(step_seconds)
        if record is not None:
            record(index)
    if finish is not None:
        finish()
    return time.perf_counter() - started


def benchmark(
    make_recorder: Callable[[], tuple[Callable[[int], None], Callable[[], None]]],
    *,
    step_durations: Sequence[float] = (0.05, 0.1, REFERENCE_STEP_SECONDS, 0.5),
    steps: int = 40,
    trials: int = 3,
    work: Callable[[float], None] = time.sleep,
) -> BenchmarkReport:
    """Measure overhead across step durations.

    Best-of-``trials`` on each arm rather than the mean: this is a wall-clock
    measurement on a shared machine, and the fastest observed run is the one
    least contaminated by whatever else the scheduler was doing. Taking the mean
    would report the noise as if it were the recorder's cost.
    """
    measurements: list[Measurement] = []
    for duration in step_durations:
        baseline = min(
            measure(step_seconds=duration, steps=steps, record=None, work=work)
            for _ in range(trials)
        )

        recorded_times: list[float] = []
        for _ in range(trials):
            record, finish = make_recorder()
            recorded_times.append(
                measure(
                    step_seconds=duration,
                    steps=steps,
                    record=record,
                    finish=finish,
                    work=work,
                )
            )

        measurements.append(
            Measurement(
                step_seconds=duration,
                steps=steps,
                baseline_seconds=baseline,
                recorded_seconds=min(recorded_times),
            )
        )

    return BenchmarkReport(measurements=tuple(measurements), trials=trials)
