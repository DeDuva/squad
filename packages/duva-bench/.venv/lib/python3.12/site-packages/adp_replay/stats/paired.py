"""Paired statistics (Task 3.1).

:func:`mcnemar_exact` landed early, with Task 0.4: a simulation-based power
analysis has to run the test it is computing power *for*, and powering a design
against one test while planning to report another is how a study arrives
underpowered on the day. The rest of this module fills in with Task 3.1.
"""

from __future__ import annotations

import random
from collections.abc import Sequence
from math import comb


def mcnemar_exact(both_pass: int, a_only: int, b_only: int, both_fail: int) -> float:
    """Exact McNemar p-value for paired pass/fail outcomes.

    Only the discordant pairs carry information: a task both models solved, or
    neither did, says nothing about which is better. Conditional on the number
    of discordant pairs, the null is that each one falls either way with equal
    probability, so this is an exact two-sided binomial test at p = 0.5.

    Exact rather than the chi-square approximation because the discordant count
    is the sample size here, not the number of tasks. A 60-task corpus can
    easily produce eight discordant pairs, and the approximation is not
    trustworthy there — which is exactly the regime a small corpus lives in.
    """
    for name, value in (
        ("both_pass", both_pass),
        ("a_only", a_only),
        ("b_only", b_only),
        ("both_fail", both_fail),
    ):
        if value < 0:
            raise ValueError(f"{name} must not be negative")

    discordant = a_only + b_only
    if discordant == 0:
        # No evidence either way. Reporting 1.0 rather than raising keeps a
        # sweep over many tasks from turning "these models tied everywhere"
        # into an exception.
        return 1.0

    smaller = min(a_only, b_only)
    tail: float = sum(comb(discordant, k) for k in range(smaller + 1)) / 2**discordant
    return min(1.0, 2.0 * tail)


def bootstrap_ci_over_tasks(
    per_task_outcomes: Sequence[Sequence[bool]],
    *,
    resamples: int = 10_000,
    confidence: float = 0.95,
    seed: int = 0,
) -> tuple[float, float]:
    """Bootstrap CI resampling **tasks**, never individual trajectories.

    Trajectories within a task are not independent samples. Resampling them
    directly treats correlated repetitions as fresh evidence and inflates
    significance — this is the single easiest way to publish a result that does
    not replicate, so the unit of resampling is fixed here by signature: the
    outer sequence is tasks, and it is the only thing resampled.

    A resampled task is taken **whole**: every one of its repetitions travels
    with it. That is what preserves the within-task correlation the interval is
    supposed to account for. Drawing repetitions independently would produce a
    narrower interval that is wrong in the direction nobody checks.

    The statistic is the mean over tasks of each task's own rate, so a task with
    thirty repetitions does not outvote one with three — the same rule the G0
    aggregation and the power analysis use.
    """
    tasks = [list(outcomes) for outcomes in per_task_outcomes if len(outcomes) > 0]
    if not tasks:
        raise ValueError("a confidence interval needs at least one task with outcomes")
    if not 0.0 < confidence < 1.0:
        raise ValueError("confidence must be between 0 and 1")

    rng = random.Random(seed)
    rates = [sum(1 for outcome in task if outcome) / len(task) for task in tasks]

    draws: list[float] = []
    count = len(rates)
    for _ in range(resamples):
        drawn = [rates[rng.randrange(count)] for _ in range(count)]
        draws.append(sum(drawn) / count)
    draws.sort()

    tail = (1.0 - confidence) / 2.0
    return (_quantile(draws, tail), _quantile(draws, 1.0 - tail))


def paired_difference_ci_over_tasks(
    baseline: Sequence[Sequence[bool]],
    treatment: Sequence[Sequence[bool]],
    *,
    resamples: int = 10_000,
    confidence: float = 0.95,
    seed: int = 0,
) -> tuple[float, float]:
    """CI for the difference in rate, resampling **tasks** and keeping pairs together.

    A paired design's whole advantage is that the same task is seen by both
    models, so task difficulty cancels. Resampling the two arms independently
    would throw that away and give a wider interval that no longer describes the
    experiment that was run — so a drawn task brings both of its arms.
    """
    if len(baseline) != len(treatment):
        raise ValueError("paired arms must have the same number of tasks")

    pairs = [
        (list(first), list(second))
        for first, second in zip(baseline, treatment, strict=True)
        if first and second
    ]
    if not pairs:
        raise ValueError("a paired interval needs at least one task with outcomes in both arms")

    rng = random.Random(seed)
    deltas = [
        sum(1 for o in second if o) / len(second) - sum(1 for o in first if o) / len(first)
        for first, second in pairs
    ]

    draws: list[float] = []
    count = len(deltas)
    for _ in range(resamples):
        drawn = [deltas[rng.randrange(count)] for _ in range(count)]
        draws.append(sum(drawn) / count)
    draws.sort()

    tail = (1.0 - confidence) / 2.0
    return (_quantile(draws, tail), _quantile(draws, 1.0 - tail))


def icc(per_task_outcomes: Sequence[Sequence[bool]]) -> float:
    """Intraclass correlation: how much variance sits between tasks vs within.

    A one-way random-effects ICC(1) on the per-repetition outcomes. It answers
    the question the plan asks — how much of what was observed is the corpus and
    how much is run-to-run noise — and it is the number that says whether a
    corpus is measuring tasks or measuring variance.

    Near 1, tasks differ and repetitions agree: the corpus is doing the work and
    more repetitions buy little. Near 0, every task behaves like every other and
    the outcome is mostly noise, which means the tasks are not discriminating
    and no amount of them will settle anything.

    Undefined without at least two tasks, and without at least one task carrying
    two repetitions — there is no within-task variance to compare against.
    """
    tasks = [list(outcomes) for outcomes in per_task_outcomes if len(outcomes) > 0]
    if len(tasks) < 2:
        raise ValueError("ICC needs at least two tasks")
    if all(len(task) < 2 for task in tasks):
        raise ValueError("ICC needs at least one task with two or more repetitions")

    total = sum(len(task) for task in tasks)
    grand = sum(sum(1 for o in task if o) for task in tasks) / total
    groups = len(tasks)

    between = sum(
        len(task) * (sum(1 for o in task if o) / len(task) - grand) ** 2 for task in tasks
    ) / (groups - 1)
    within_df = total - groups
    if within_df == 0:
        raise ValueError("ICC needs at least one task with two or more repetitions")
    within = (
        sum(
            sum(((1.0 if outcome else 0.0) - mean) ** 2 for outcome in task)
            for task, mean in ((task, sum(1 for o in task if o) / len(task)) for task in tasks)
        )
        / within_df
    )

    # The balanced-design group size, used as the effective n when repetition
    # counts differ. Reduces to the common count when the design is balanced.
    if groups > 1:
        sizes = [len(task) for task in tasks]
        effective = (total - sum(size**2 for size in sizes) / total) / (groups - 1)
    else:  # pragma: no cover - guarded above
        effective = 1.0

    denominator = between + (effective - 1) * within
    if denominator == 0:
        return 0.0
    value = (between - within) / denominator
    # ICC is a proportion of variance; a negative estimate means the between
    # component is smaller than the within one, which is reported as zero rather
    # than as a negative share of variance.
    return max(0.0, min(1.0, value))


def variance_decomposition(per_task_outcomes: Sequence[Sequence[bool]]) -> dict[str, float]:
    """How much variance sits between tasks versus within them."""
    coefficient = icc(per_task_outcomes)
    return {
        "icc": coefficient,
        "between_tasks": coefficient,
        "within_tasks": 1.0 - coefficient,
    }


def _quantile(values: Sequence[float], q: float) -> float:
    """Linear-interpolated quantile over a sorted sample."""
    if not values:
        return float("nan")
    if len(values) == 1:
        return values[0]
    position = q * (len(values) - 1)
    low = int(position)
    high = min(low + 1, len(values) - 1)
    return values[low] + (values[high] - values[low]) * (position - low)
