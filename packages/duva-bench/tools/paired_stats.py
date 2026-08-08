"""Paired statistics for a duva-bench study, computed by adp-replay's library.

Both duva-bench tracks share this code path on purpose. The squad track and the
Harbor track differ in how a trial is executed and in nothing else, so if they
also differed in how a difference is tested, a divergence between them would be
uninterpretable — you would not know whether the platforms disagreed or the
statistics did. Importing `adp_replay.stats.paired` rather than reimplementing
it means the two tracks' numbers differ only by their data.

Reads an outcomes bundle on stdin, writes a result bundle on stdout:

    {"axis": "acceptance", "baseline": "standard", "seed": 0,
     "arms": {"standard": {"retry": [true, false], ...}, ...}}

Every function here is binary-outcome by design. McNemar and the paired
bootstrap test pass/fail, and the grader's own `passed` is what is fed in —
thresholding a score to manufacture a boolean would invent a cut-off the grader
never declared. Continuous metrics are not tested here; they are read against
the measured noise floor instead, which is what `variance.ts` is for.

Resampling is over **tasks**, never over individual trials: repetitions within
one task are not independent samples, and resampling them directly treats
correlated repeats as fresh evidence.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.expanduser("~"), "dev", "adp-replay", "src"))

from adp_replay.stats.paired import (  # noqa: E402
    bootstrap_ci_over_tasks,
    icc,
    mcnemar_exact,
    paired_difference_ci_over_tasks,
)


def _aligned(arms: dict, a: str, b: str) -> tuple[list, list, list]:
    """The tasks both arms saw, in a stable order.

    A paired design's whole advantage is that the same task is seen by both
    arms, so task difficulty cancels. Any task only one arm ran is dropped
    rather than filled in, and the count of dropped tasks is reported.
    """
    shared = sorted(set(arms[a]) & set(arms[b]))
    return shared, [arms[a][t] for t in shared], [arms[b][t] for t in shared]


def _rate(per_task: list) -> float:
    flat = [bool(v) for task in per_task for v in task]
    return sum(flat) / len(flat) if flat else 0.0


def holm(pairs: list[dict]) -> None:
    """Holm-Bonferroni, in place.

    With more than two arms every extra contrast is another chance to find
    something, and an uncorrected family of comparisons is how a study reports
    an effect it did not have. Holm rather than Bonferroni because it is
    uniformly more powerful at the same guarantee.
    """
    ordered = sorted(range(len(pairs)), key=lambda i: pairs[i]["p_value"])
    m = len(ordered)
    running = 0.0
    for rank, index in enumerate(ordered):
        adjusted = min(1.0, (m - rank) * pairs[index]["p_value"])
        # Monotone: a corrected p may never fall below one ranked before it.
        running = max(running, adjusted)
        pairs[index]["p_value_holm"] = running
        pairs[index]["holm_rank"] = rank + 1


def main() -> int:
    request = json.load(sys.stdin)
    arms: dict = request["arms"]
    seed = int(request.get("seed", 0))
    resamples = int(request.get("resamples", 10_000))
    confidence = float(request.get("confidence", 0.95))
    baseline = request.get("baseline") or (sorted(arms)[0] if arms else None)

    per_arm = []
    for name in sorted(arms):
        per_task = [arms[name][t] for t in sorted(arms[name])]
        if not per_task:
            per_arm.append({"arm": name, "n_tasks": 0, "rate": None, "ci": None, "icc": None})
            continue
        low, high = bootstrap_ci_over_tasks(
            per_task, resamples=resamples, confidence=confidence, seed=seed
        )
        per_arm.append(
            {
                "arm": name,
                "n_tasks": len(per_task),
                "n_trials": sum(len(t) for t in per_task),
                "rate": _rate(per_task),
                "ci": [low, high],
                # Near 0 the tasks are not discriminating and no number of them
                # will settle anything; that is worth printing beside the rate.
                "icc": icc(per_task) if len(per_task) >= 2 else None,
            }
        )

    pairs = []
    if baseline in arms:
        for name in sorted(arms):
            if name == baseline:
                continue
            shared, base_task, treat_task = _aligned(arms, baseline, name)
            if not shared:
                continue

            # McNemar over paired trials: repetitions are zipped positionally
            # within a task, which is the only pairing the design supports.
            both_pass = a_only = b_only = both_fail = 0
            for base_reps, treat_reps in zip(base_task, treat_task):
                for base, treat in zip(base_reps, treat_reps):
                    if base and treat:
                        both_pass += 1
                    elif base and not treat:
                        a_only += 1
                    elif treat and not base:
                        b_only += 1
                    else:
                        both_fail += 1

            low, high = paired_difference_ci_over_tasks(
                base_task, treat_task, resamples=resamples, confidence=confidence, seed=seed
            )
            pairs.append(
                {
                    "baseline": baseline,
                    "arm": name,
                    "shared_tasks": len(shared),
                    "dropped_tasks": len(set(arms[baseline]) ^ set(arms[name])),
                    "difference": _rate(treat_task) - _rate(base_task),
                    "ci": [low, high],
                    "p_value": mcnemar_exact(both_pass, a_only, b_only, both_fail),
                    "discordant": {"baseline_only": a_only, "arm_only": b_only},
                }
            )
        holm(pairs)

    json.dump(
        {
            "axis": request.get("axis"),
            "baseline": baseline,
            "seed": seed,
            "resamples": resamples,
            "confidence": confidence,
            "arms": per_arm,
            "pairs": pairs,
        },
        sys.stdout,
        indent=2,
        sort_keys=True,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
