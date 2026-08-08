"""Simulation-based power analysis (Task 0.4).

This task sets the corpus size. Task 1.3's closure audit takes its target from
here and audits at least 1.25x it to absorb attrition — fixing a corpus size
before this reports means re-running the audit when the number moves.

The simulation runs the analysis it is powering. Two models are run on the same
tasks; each task's outcome is decided by a majority of its repetitions; the
paired outcomes go to the exact McNemar test the plan commits to. Powering a
design against a test other than the one that will be reported is how a study
arrives underpowered on the day it is analysed.

The data-generating model is hierarchical, because the corpus is:

* each task has a latent difficulty drawn on the logit scale, and the spread of
  those difficulties is the dominant source of variance in an agentic corpus —
  some tasks are solved by everything, some by nothing;
* within a task, repetitions are independent Bernoulli draws at that task's
  success probability, which is where run-to-run nondeterminism lives.

Repetitions are handled analytically rather than sampled: given a task's success
probability, the chance a majority of ``n`` of them pass is a binomial tail with
a closed form. That makes the simulation faster and exact in the one place
sampling would only have added noise.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from functools import cache
from typing import Any

from adp_replay.stats.paired import mcnemar_exact

# Simpson's rule over +/- 8 standard deviations. Enough nodes that calibration
# is exact to far more decimal places than an assumed effect size deserves.
_QUADRATURE_NODES = 401
_QUADRATURE_SPAN = 8.0


@dataclass(frozen=True)
class Assumptions:
    """What the recommendation is conditional on.

    Every field here is a guess until the closure audit produces pilot data.
    They are a dataclass rather than defaults buried in a signature so that a
    report can print them, and so that changing one is a visible edit.
    """

    # Marginal success rate of the weaker model, across the corpus.
    base_rate: float = 0.45
    # The smallest difference in success rate worth detecting, on the
    # probability scale: 0.10 means 45% against 55%.
    effect_size: float = 0.10
    # Spread of task difficulty on the logit scale. 1.5 puts the middle half of
    # tasks roughly between 20% and 72% success at a 45% marginal rate — a
    # corpus with genuinely easy and genuinely hard tasks in it.
    between_task_sd: float = 1.5
    alpha: float = 0.05

    def replace(self, **changes: float) -> Assumptions:
        return Assumptions(**{**self.__dict__, **changes})


@dataclass(frozen=True)
class PowerRecommendation:
    """The smallest design reaching the target power."""

    tasks: int
    repetitions: int
    power: float
    assumed_effect_size: float
    assumed_variance: float
    target_power: float = 0.8
    assumptions: Assumptions = field(default_factory=Assumptions)
    # Power at the same design under neighbouring assumptions. A design that
    # only holds at one assumed effect size is a number, not a result.
    effect_sensitivity: tuple[tuple[float, float], ...] = ()
    variance_sensitivity: tuple[tuple[float, float], ...] = ()
    # Every design the search evaluated, so the shape of the trade-off is
    # visible rather than only its argmin.
    frontier: tuple[tuple[int, int, float], ...] = ()
    # Designs that were cheaper and did reach the target, and were ruled out
    # anyway because they cannot support the analysis the plan commits to.
    # Reported rather than dropped: "we did not pick the cheapest design" is a
    # claim that needs its reason attached.
    excluded_cheaper: tuple[tuple[int, int, float], ...] = ()

    @property
    def trajectories(self) -> int:
        """Runs this design costs: both models, every task, every repetition."""
        return self.tasks * self.repetitions * 2


def _logistic(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _normal_pdf(x: float, mu: float, sd: float) -> float:
    z = (x - mu) / sd
    return math.exp(-0.5 * z * z) / (sd * math.sqrt(2.0 * math.pi))


def _mean_success(mu: float, sd: float) -> float:
    """E[logistic(theta)] for theta ~ Normal(mu, sd), by quadrature."""
    low = mu - _QUADRATURE_SPAN * sd
    high = mu + _QUADRATURE_SPAN * sd
    step = (high - low) / (_QUADRATURE_NODES - 1)

    total = 0.0
    for index in range(_QUADRATURE_NODES):
        x = low + index * step
        weight = 1.0 if index in (0, _QUADRATURE_NODES - 1) else (4.0 if index % 2 else 2.0)
        total += weight * _normal_pdf(x, mu, sd) * _logistic(x)
    return total * step / 3.0


def _solve_mean(target: float, sd: float) -> float:
    """The mu whose marginal success rate is ``target``, by bisection."""
    low, high = -20.0, 20.0
    for _ in range(200):
        mid = (low + high) / 2.0
        if _mean_success(mid, sd) < target:
            low = mid
        else:
            high = mid
    return (low + high) / 2.0


def calibrate(assumptions: Assumptions) -> tuple[float, float]:
    """Latent mean and treatment shift matching the assumed rates.

    The assumptions are stated on the probability scale because that is where a
    reader has intuitions — "45% against 55%" means something, "a log-odds
    effect of 0.41" does not. The model works on the logit scale, so the two are
    reconciled here rather than by asking anyone to convert.
    """
    weaker = assumptions.base_rate
    stronger = assumptions.base_rate + assumptions.effect_size
    if not 0.0 < weaker < stronger < 1.0:
        raise ValueError(
            "base_rate and effect_size must define two rates inside (0, 1): "
            f"got {weaker} and {stronger}"
        )

    mu = _solve_mean(weaker, assumptions.between_task_sd)
    shifted = _solve_mean(stronger, assumptions.between_task_sd)
    return mu, shifted - mu


@cache
def _majority_pass(probability_key: int, repetitions: int) -> float:
    """P(more than half of ``repetitions`` succeed), exactly.

    Cached on a quantized probability: the caller draws task difficulties from a
    continuum, and rounding to four decimals costs nothing a simulation can
    detect while turning a per-draw binomial sum into a lookup.
    """
    p = probability_key / 10_000.0
    needed = repetitions // 2 + 1
    return sum(
        math.comb(repetitions, k) * p**k * (1.0 - p) ** (repetitions - k)
        for k in range(needed, repetitions + 1)
    )


def majority_pass_probability(p: float, repetitions: int) -> float:
    """Chance a task counts as solved, given per-repetition success ``p``."""
    return _majority_pass(round(p * 10_000), repetitions)


def simulate_power(
    tasks: int,
    repetitions: int,
    *,
    assumptions: Assumptions | None = None,
    trials: int = 2_000,
    seed: int = 0,
) -> float:
    """Fraction of simulated experiments in which exact McNemar rejects.

    A tie is a failure: with an even number of repetitions, a task that splits
    evenly does not count as solved. Stating that rather than forbidding even
    ``n`` keeps the frontier continuous, and the recommendation lands on an odd
    ``n`` anyway because an even one spends a repetition to no effect.
    """
    if tasks < 1 or repetitions < 1:
        raise ValueError("a design needs at least one task and one repetition")

    settings = assumptions or Assumptions()
    mu, shift = calibrate(settings)
    sd = settings.between_task_sd
    rng = random.Random(seed)

    rejections = 0
    for _ in range(trials):
        weaker_only = stronger_only = 0
        for _ in range(tasks):
            difficulty = rng.gauss(mu, sd)
            weaker = majority_pass_probability(_logistic(difficulty), repetitions)
            stronger = majority_pass_probability(_logistic(difficulty + shift), repetitions)

            weaker_solved = rng.random() < weaker
            stronger_solved = rng.random() < stronger
            if weaker_solved and not stronger_solved:
                weaker_only += 1
            elif stronger_solved and not weaker_solved:
                stronger_only += 1

        if mcnemar_exact(0, weaker_only, stronger_only, 0) <= settings.alpha:
            rejections += 1

    return rejections / trials


def recommend_design(
    target_power: float = 0.8,
    *,
    effect_size: float | None = None,
    variance: float | None = None,
    assumptions: Assumptions | None = None,
    task_grid: tuple[int, ...] = tuple(range(20, 401, 10)),
    repetition_grid: tuple[int, ...] = (1, 3, 5, 7, 9, 11, 15),
    min_repetitions: int = 3,
    search_trials: int = 400,
    trials: int = 4_000,
    seed: int = 0,
) -> PowerRecommendation:
    """Smallest (T, n) achieving ``target_power``.

    Task 0.4. "Smallest" is by total trajectories — the cost of the experiment
    is runs, and one design is cheaper than another when it needs fewer of them.
    Ties break towards *more tasks*, because tasks and repetitions are not
    interchangeable downstream: confidence intervals resample tasks and never
    trajectories (Task 3.1), so a design with more tasks buys a usable interval
    as well as a rejection.

    The grid starts at 20 tasks. Below that, a bootstrap over tasks reports the
    resampling rather than the corpus, so a design that reached power with
    twelve tasks would satisfy this function and fail the analysis it feeds.

    ``min_repetitions`` is there for the same reason at the other axis. Task 3.1
    commits to reporting ICC and a variance decomposition — how much variance
    sits between tasks and how much within — and within-task variance is not
    defined at one repetition and barely estimable at two. Single-run designs
    are usually the cheapest way to reach a given power, and they are excluded
    here rather than silently lost: whichever ones cleared the target are
    reported on the recommendation as ``excluded_cheaper``.

    Searched coarsely, then confirmed: the winner is re-simulated at ``trials``,
    so the reported power is not the noisy estimate that happened to win a scan.
    """
    settings = assumptions or Assumptions()
    if effect_size is not None:
        settings = settings.replace(effect_size=effect_size)
    if variance is not None:
        settings = settings.replace(between_task_sd=math.sqrt(variance))

    frontier: list[tuple[int, int, float]] = []
    winners: list[tuple[int, int, int, float]] = []
    excluded: list[tuple[int, int, float]] = []
    for repetitions in repetition_grid:
        found = _smallest_task_count(
            repetitions,
            settings=settings,
            target_power=target_power,
            task_grid=task_grid,
            search_trials=search_trials,
            trials=trials,
            seed=seed,
            frontier=frontier,
        )
        if found is None:
            continue
        tasks, power = found
        if repetitions < min_repetitions:
            excluded.append((tasks, repetitions, power))
        else:
            winners.append((tasks * repetitions, tasks, repetitions, power))

    if not winners:
        raise ValueError(
            f"no design on the grid reaches power {target_power} under {settings} "
            f"with at least {min_repetitions} repetitions; widen the grid or accept a "
            "larger detectable effect"
        )

    # Cheapest by total trajectories; ties go to the design with more tasks,
    # since only tasks buy a usable confidence interval downstream.
    _, tasks, repetitions, confirmed = min(winners, key=lambda w: (w[0], -w[1]))

    return PowerRecommendation(
        excluded_cheaper=tuple(
            sorted((t, n, p) for t, n, p in excluded if t * n < tasks * repetitions)
        ),
        tasks=tasks,
        repetitions=repetitions,
        power=confirmed,
        assumed_effect_size=settings.effect_size,
        assumed_variance=settings.between_task_sd**2,
        target_power=target_power,
        assumptions=settings,
        effect_sensitivity=_sweep(
            tasks, repetitions, settings, "effect_size", (0.05, 0.075, 0.10, 0.125, 0.15), seed
        ),
        variance_sensitivity=_sweep(
            tasks, repetitions, settings, "between_task_sd", (0.75, 1.0, 1.5, 2.0, 2.5), seed
        ),
        frontier=tuple(sorted(frontier)),
    )


def _smallest_task_count(
    repetitions: int,
    *,
    settings: Assumptions,
    target_power: float,
    task_grid: tuple[int, ...],
    search_trials: int,
    trials: int,
    seed: int,
    frontier: list[tuple[int, int, float]],
) -> tuple[int, float] | None:
    """Fewest tasks at this ``repetitions`` whose *confirmed* power clears the bar.

    Power is monotone in task count, so the screen can binary-search. What it
    cannot do is decide: a coarse estimate that crosses the target is as likely
    to have crossed it by luck as by merit, and reporting that design would ship
    a recommendation which does not meet its own target. So the screen only
    localizes, and the answer walks up the grid confirming at full precision
    until one actually holds.
    """

    def screen(tasks: int) -> float:
        power = simulate_power(
            tasks, repetitions, assumptions=settings, trials=search_trials, seed=seed
        )
        frontier.append((tasks, repetitions, power))
        return power

    # The screen is deliberately generous: three standard errors of its own
    # estimate below the target. A screen held to the target exactly rejects a
    # design sitting right on it about half the time, and rejects it silently —
    # a whole repetition count can disappear from the search on noise. Being
    # generous costs a few confirmations; being exact costs the answer.
    margin = 3.0 * math.sqrt(0.25 / search_trials)
    admit = target_power - margin

    if screen(task_grid[-1]) < admit:
        return None

    low, high = 0, len(task_grid) - 1
    while low < high:
        middle = (low + high) // 2
        if screen(task_grid[middle]) >= admit:
            high = middle
        else:
            low = middle + 1

    for index in range(low, len(task_grid)):
        confirmed = simulate_power(
            task_grid[index], repetitions, assumptions=settings, trials=trials, seed=seed + 1
        )
        if confirmed >= target_power:
            return task_grid[index], confirmed
    return None


def _sweep(
    tasks: int,
    repetitions: int,
    settings: Assumptions,
    field_name: str,
    values: tuple[float, ...],
    seed: int,
) -> tuple[tuple[float, float], ...]:
    """Power of one design as a single assumption is varied around its value."""
    return tuple(
        (
            value,
            simulate_power(
                tasks,
                repetitions,
                assumptions=settings.replace(**{field_name: value}),
                trials=1_500,
                seed=seed + 2,
            ),
        )
        for value in values
    )


def report(recommendation: PowerRecommendation) -> dict[str, Any]:
    """The recommendation as a serializable record, assumptions included.

    The assumptions travel with the number. A corpus size quoted without them is
    a number someone will reuse after the assumptions have moved.
    """
    return {
        "target_power": recommendation.target_power,
        "tasks": recommendation.tasks,
        "repetitions": recommendation.repetitions,
        "power": round(recommendation.power, 4),
        "trajectories": recommendation.trajectories,
        "audit_target": math.ceil(recommendation.tasks * 1.25),
        "assumptions": {
            "base_rate": recommendation.assumptions.base_rate,
            "effect_size": recommendation.assumptions.effect_size,
            "between_task_sd": recommendation.assumptions.between_task_sd,
            "between_task_variance": round(recommendation.assumed_variance, 4),
            "alpha": recommendation.assumptions.alpha,
        },
        "excluded_cheaper": [
            {"tasks": t, "repetitions": n, "power": round(p, 4), "trajectories": t * n * 2}
            for t, n, p in recommendation.excluded_cheaper
        ],
        "min_repetitions_reason": (
            "Task 3.1 reports ICC and a between/within variance decomposition, "
            "which is undefined at one repetition"
        ),
        "primary_outcome": "task solved when a majority of its repetitions pass",
        "test": "exact McNemar on paired per-task outcomes",
        "resampling_unit": "tasks",
        "sensitivity": {
            "effect_size": [
                [value, round(power, 4)] for value, power in recommendation.effect_sensitivity
            ],
            "between_task_sd": [
                [value, round(power, 4)] for value, power in recommendation.variance_sensitivity
            ],
        },
    }


def render_markdown(recommendation: PowerRecommendation) -> str:
    settings = recommendation.assumptions
    audit_target = math.ceil(recommendation.tasks * 1.25)
    lines = [
        "# Task 0.4 — power analysis",
        "",
        f"**{recommendation.tasks} tasks x {recommendation.repetitions} repetitions** reaches "
        f"power {recommendation.power:.3f} against a target of {recommendation.target_power}.",
        "",
        f"That is {recommendation.trajectories} recorded trajectories across both models. "
        f"Task 1.3 audits at least {audit_target} tasks (1.25x) to absorb attrition.",
        "",
        "## Assumptions",
        "",
        "Every one of these is a guess until pilot data replaces it.",
        "",
        "| assumption | value |",
        "|---|---|",
        f"| base success rate | {settings.base_rate} |",
        f"| effect size to detect | {settings.effect_size} |",
        f"| between-task SD (logit) | {settings.between_task_sd} |",
        f"| alpha | {settings.alpha} |",
        "",
        "## Design",
        "",
        "- Primary outcome: a task counts as solved when a majority of its repetitions pass.",
        "- Test: exact McNemar on the paired per-task outcomes.",
        "- Confidence intervals resample **tasks**, never trajectories.",
        "",
        "## Sensitivity",
        "",
        "A design that only holds at one assumed effect size is a number, not a result.",
        "",
        "| effect size | power |",
        "|---|---|",
    ]
    for value, power in recommendation.effect_sensitivity:
        lines.append(f"| {value} | {power:.3f} |")

    lines += ["", "| between-task SD | power |", "|---|---|"]
    for value, power in recommendation.variance_sensitivity:
        lines.append(f"| {value} | {power:.3f} |")

    lines += [
        "",
        "Power rises with between-task spread rather than falling, which is worth stating",
        "because it reads backwards. Holding the marginal success rate fixed, a wider spread",
        "of task difficulty needs a larger shift on the log-odds scale to move that rate by",
        "the same ten points — and the larger shift produces more discordant pairs, which are",
        "the only pairs McNemar reads. The design is therefore not at risk from a corpus that",
        "turns out more heterogeneous than assumed; it is at risk from a smaller true effect.",
    ]

    if recommendation.excluded_cheaper:
        lines += [
            "",
            "## Cheaper designs that were not chosen",
            "",
            "These reached the target power for fewer trajectories and were still ruled out.",
            "Task 3.1 commits to reporting ICC and a between/within variance decomposition,",
            "and within-task variance is not defined at a single repetition. A design cannot",
            "be recommended on cost when it cannot support the analysis it exists to feed.",
            "",
            "| tasks | repetitions | power | trajectories |",
            "|---|---|---|---|",
        ]
        for tasks, reps, power in recommendation.excluded_cheaper:
            lines.append(f"| {tasks} | {reps} | {power:.3f} | {tasks * reps * 2} |")

    return "\n".join(lines) + "\n"
