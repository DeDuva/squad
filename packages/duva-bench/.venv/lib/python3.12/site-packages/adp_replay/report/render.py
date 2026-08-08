"""Report rendering (Task 3.2).

State completeness and median context fidelity go in the **header** of every
report. Both are limits on what the numbers below them mean, and a limit that
appears after the conclusion has already been read is not a limit.

The JSON schema is documented in ``docs/report-schema.md``. The HTML is
self-contained — no external stylesheet, no font, no script — because a report
that needs the network to render is a report that stops rendering, and an
artifact nobody can open in five years is not evidence.
"""

from __future__ import annotations

import html
import json
from dataclasses import dataclass, field
from typing import Any

from adp_replay.manifest.models import StateCompleteness
from adp_replay.replay.fork import CONTINUATION_BANNER, ReplayResult, assert_comparable
from adp_replay.stats.paired import (
    bootstrap_ci_over_tasks,
    mcnemar_exact,
    paired_difference_ci_over_tasks,
    variance_decomposition,
)

SCHEMA_VERSION = "0.1.0"


@dataclass(frozen=True)
class Arm:
    """One model's results across the corpus."""

    label: str
    results: tuple[ReplayResult, ...]

    @property
    def per_task_outcomes(self) -> list[list[bool]]:
        from adp_replay.verdict import Verdict

        return [
            [attempt.verdict is Verdict.PASS for attempt in result.attempts]
            for result in self.results
        ]

    @property
    def solved(self) -> int:
        return sum(1 for result in self.results if result.solved)

    @property
    def errors(self) -> int:
        return sum(result.errors for result in self.results)


@dataclass(frozen=True)
class Report:
    """A comparison of two arms, with everything needed to read it honestly."""

    baseline: Arm
    treatment: Arm
    state_completeness: StateCompleteness
    median_context_fidelity: float | None
    corpus_digest: str | None = None
    adp_contract_version: str | None = None
    notes: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if len(self.baseline.results) != len(self.treatment.results):
            raise ValueError("a paired report needs the same tasks in both arms")
        # Refuse a comparison across differing scorers before rendering one.
        # A report is exactly where an incomparable pair would stop looking
        # incomparable.
        assert_comparable([*self.baseline.results, *self.treatment.results])

    @property
    def is_model_comparison(self) -> bool:
        return all(
            result.is_model_comparison
            for result in (*self.baseline.results, *self.treatment.results)
        )

    @property
    def banner(self) -> str | None:
        """Present whenever any result in the report is a continuation diagnostic."""
        if any(
            result.banner is not None
            for result in (*self.baseline.results, *self.treatment.results)
        ):
            return CONTINUATION_BANNER
        return None

    @property
    def contingency(self) -> dict[str, int]:
        """The paired table McNemar reads."""
        both = baseline_only = treatment_only = neither = 0
        for first, second in zip(self.baseline.results, self.treatment.results, strict=True):
            if first.solved and second.solved:
                both += 1
            elif first.solved:
                baseline_only += 1
            elif second.solved:
                treatment_only += 1
            else:
                neither += 1
        return {
            "both": both,
            "baseline_only": baseline_only,
            "treatment_only": treatment_only,
            "neither": neither,
        }

    def statistics(self, *, resamples: int = 10_000, seed: int = 0) -> dict[str, Any]:
        table = self.contingency
        p_value = mcnemar_exact(
            table["both"], table["baseline_only"], table["treatment_only"], table["neither"]
        )
        low, high = paired_difference_ci_over_tasks(
            self.baseline.per_task_outcomes,
            self.treatment.per_task_outcomes,
            resamples=resamples,
            seed=seed,
        )
        return {
            "test": "exact McNemar on paired per-task outcomes",
            "p_value": p_value,
            "contingency": table,
            "difference_ci": [low, high],
            "confidence": 0.95,
            "resampling_unit": "tasks",
            "baseline": _arm_stats(self.baseline, resamples=resamples, seed=seed),
            "treatment": _arm_stats(self.treatment, resamples=resamples, seed=seed),
        }

    def to_dict(self, *, resamples: int = 10_000, seed: int = 0) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            # The header, and it is the header in the JSON too: a consumer that
            # reads only the top of this document still gets the limits.
            "state_completeness": self.state_completeness.value,
            "median_context_fidelity": self.median_context_fidelity,
            "is_model_comparison": self.is_model_comparison,
            "corpus_digest": self.corpus_digest,
            "adp_contract_version": self.adp_contract_version,
            "tasks": len(self.baseline.results),
            "arms": {"baseline": self.baseline.label, "treatment": self.treatment.label},
            "statistics": self.statistics(resamples=resamples, seed=seed),
            "results": {
                "baseline": [result.to_dict() for result in self.baseline.results],
                "treatment": [result.to_dict() for result in self.treatment.results],
            },
        }
        if self.banner is not None:
            payload["banner"] = self.banner
        return payload


def _arm_stats(arm: Arm, *, resamples: int, seed: int) -> dict[str, Any]:
    outcomes = arm.per_task_outcomes
    low, high = bootstrap_ci_over_tasks(outcomes, resamples=resamples, seed=seed)
    stats: dict[str, Any] = {
        "label": arm.label,
        "solved": arm.solved,
        "errors": arm.errors,
        "rate_ci": [low, high],
    }
    try:
        stats["variance"] = variance_decomposition(outcomes)
    except ValueError as exc:
        # Not enough repetitions to separate between-task from within-task
        # variance. Said out loud rather than reported as zero, which would read
        # as "no within-task variance" instead of "not measured".
        stats["variance"] = {"unavailable": str(exc)}
    return stats


def render_json(results: Report, *, resamples: int = 10_000, seed: int = 0) -> str:
    """Render results as JSON, against the schema in docs/report-schema.md."""
    return json.dumps(results.to_dict(resamples=resamples, seed=seed), indent=2) + "\n"


def render_html(results: Report, *, resamples: int = 10_000, seed: int = 0) -> str:
    """Render a self-contained HTML report — no external asset references."""
    payload = results.to_dict(resamples=resamples, seed=seed)
    statistics = payload["statistics"]
    table = statistics["contingency"]

    fidelity = payload["median_context_fidelity"]
    fidelity_text = "not measured" if fidelity is None else f"{fidelity:.3f}"
    low, high = statistics["difference_ci"]

    banner_block = (
        f'<p class="banner">{html.escape(payload["banner"])}</p>' if payload.get("banner") else ""
    )

    rows = "".join(
        f"<tr><td>{html.escape(str(key))}</td><td>{value}</td></tr>" for key, value in table.items()
    )

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>adp-replay report</title>
<style>
  body {{ font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 46rem; }}
  .header {{ border: 1px solid #999; padding: 1rem; margin-bottom: 1.5rem; }}
  .header dt {{ font-weight: 600; }}
  .banner {{ border-left: 4px solid #b00; padding-left: .75rem; font-weight: 600; }}
  table {{ border-collapse: collapse; }}
  td, th {{ border: 1px solid #ccc; padding: .3rem .6rem; text-align: left; }}
</style></head>
<body>
<h1>adp-replay report</h1>
<section class="header">
  <dl>
    <dt>State completeness</dt><dd>{html.escape(payload["state_completeness"])}</dd>
    <dt>Median context fidelity</dt><dd>{html.escape(fidelity_text)}</dd>
    <dt>Model comparison</dt><dd>{"yes" if payload["is_model_comparison"] else "no"}</dd>
    <dt>Tasks</dt><dd>{payload["tasks"]}</dd>
  </dl>
  {banner_block}
</section>
<h2>Result</h2>
<p>
  {html.escape(str(payload["arms"]["baseline"]))} solved
  {statistics["baseline"]["solved"]}; {html.escape(str(payload["arms"]["treatment"]))} solved
  {statistics["treatment"]["solved"]}.
  Exact McNemar p = {statistics["p_value"]:.4g}.
  95% CI for the difference, resampling <strong>tasks</strong>:
  [{low:.3f}, {high:.3f}].
</p>
<table><tr><th>cell</th><th>tasks</th></tr>{rows}</table>
</body></html>
"""
