"""Paired statistics for a duva-bench study, computed by adp-replay's library.

Both duva-bench tracks share this code path on purpose. The squad track and the
Harbor track differ in how a trial is executed and in nothing else, so if they
also differed in how a difference is tested, a divergence between them would be
uninterpretable — you would not know whether the platforms disagreed or the
statistics did. Importing `adp_replay.stats.paired` rather than reimplementing
it means the two tracks' numbers differ only by their data.

That claim used to be weaker than it read. Until 2026-08-08 this module reached
into a *working copy* — `sys.path.insert(0, ~/dev/adp-replay/src)` — so the
statistics behind a published number were whatever happened to be checked out on
one laptop, no CI could run this path at all, and the study digest covered the
study spec but not the code that turned it into a result. It is now an ordinary
installed dependency pinned by commit in `requirements-stats.txt`, installed by
`scripts/setup-stats.sh`.

The version it resolved to is reported as `stats_version` **on every result**,
deliberately not folded into the study digest: a study digest identifies the
experiment, and re-analysing the same experiment does not make it a different
one. Folding it in would also mean bumping the pin orphaned every recorded
trial. So the pin travels with the answer instead of with the question.

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
import sys
from importlib.metadata import PackageNotFoundError, distribution, version

from adp_replay.stats.paired import (
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


def _stats_version() -> str:
    """What identifies the statistics that produced a result.

    Prefers the resolved **commit**, which pip records in `direct_url.json` for
    a VCS install, because that is what `requirements-stats.txt` actually pins.
    The declared package version is not enough on its own: adp-replay declares
    `0.0.0`, so two different pins would report the same string and a reader
    comparing two results could not tell them apart.

    Falls back to the declared version, then to `unknown` — never to a guess. A
    report that invented a version would be worse than one admitting it cannot
    tell.
    """
    declared = "unknown"
    try:
        declared = version("adp-replay")
    except PackageNotFoundError:
        return "unknown"

    try:
        raw = distribution("adp-replay").read_text("direct_url.json")
        if raw:
            commit = json.loads(raw).get("vcs_info", {}).get("commit_id")
            if commit:
                return f"{declared}+git.{commit[:12]}"
    except (PackageNotFoundError, OSError, ValueError):
        pass
    return declared


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
            # Which statistics produced this. A study digest identifies the
            # experiment, not the code that turned it into a number — so
            # without this a result re-computed under a different pin is
            # silently a different result. Recorded with the answer rather
            # than folded into the study digest, because re-analysing a study
            # does not make it a different study.
            "stats_version": _stats_version(),
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
