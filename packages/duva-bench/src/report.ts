/**
 * The report: what the study found, and everything needed to disbelieve it.
 *
 * A report that only prints results is an argument. This prints the study
 * digest, the pre-registration in both readings, every trial's verify status,
 * the exclusion counts, the noise floor *before* any contrast, and the cost
 * ledger — so a reader can check the claim rather than accept it.
 *
 * Four rules are load-bearing and each is visible in the output:
 *
 * - **Per axis, never blended.** One table per axis. There is no overall score,
 *   because the moment one exists someone ranks on it.
 * - **Unscored is not zero, unpriced is not $0.00.** Both render as words.
 * - **The noise floor comes first.** A contrast is printed in units of the
 *   within-cell spread, because a gap of 0.1 means one thing when repeats vary
 *   by 0.01 and nothing at all when they vary by 0.2.
 * - **Errors count against the majority.** A run ADP could not verify is an
 *   `ERROR`, excluded from every statistic and printed with its count.
 */

import {
  costLedger,
  includedTrials,
  summariseCells,
  type NoiseFloor,
  type Outcomes,
  type TrialOutcome,
} from './analysis.js';
import { preRegistrationReading, shortDigest, armDigest, type Study } from './study.js';
import type { StatsResult } from './stats-bridge.js';

export interface ReportInput {
  study: Study;
  outcomes: Outcomes;
  noiseFloors: NoiseFloor[];
  /** Per axis. Absent when the bridge could not run — said out loud, not hidden. */
  stats: Record<string, StatsResult>;
  statsUnavailable?: string;
}

// ─── report.json ─────────────────────────────────────────────────────────

export function buildReport(input: ReportInput) {
  const { study, outcomes } = input;
  const reading = preRegistrationReading(study.preRegistration);
  const axes = [...new Set(includedTrials(outcomes).flatMap((t) => Object.keys(t.axes)))].sort();

  return {
    study: {
      title: study.title,
      digest: outcomes.studyDigest,
      short: shortDigest(outcomes.studyDigest),
      arms: study.arms.map((arm) => ({
        id: arm.id,
        digest: armDigest(arm),
        harness: arm.harness,
        topology: arm.topology,
        model: arm.model,
        toolset: arm.toolset,
      })),
      tasks: study.tasks.map((t) => ({ id: t.id, graderSha256: t.graderSha256 })),
    },
    // Printed unchanged, or with the amendment beside the reading it replaced.
    preRegistration: {
      registered: reading.registered,
      current: reading.current,
      registeredDigest: reading.registeredDigest,
      currentDigest: reading.currentDigest,
      amended: reading.amended,
    },
    collectedAt: outcomes.collectedAt,
    counts: {
      trials: outcomes.trials.length,
      included: includedTrials(outcomes).length,
      errors: outcomes.trials.filter((t) => t.verdict === 'ERROR').length,
      missing: outcomes.missing.length,
    },
    exclusions: outcomes.exclusions,
    noiseFloors: input.noiseFloors,
    cells: summariseCells(outcomes, axes),
    statistics: input.stats,
    ...(input.statsUnavailable ? { statisticsUnavailable: input.statsUnavailable } : {}),
    costLedger: costLedger(outcomes),
    // Every trial, with its verify status — the evidence, not a summary of it.
    trials: outcomes.trials.map((t) => ({
      externalRef: t.externalRef,
      runId: t.runId,
      armId: t.armId,
      taskId: t.taskId,
      rep: t.rep,
      status: t.status,
      verified: t.verified,
      verdict: t.verdict,
      excludedBy: t.excludedBy,
      axes: t.axes,
      axesPassed: t.axesPassed,
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
      costMicroUsd: t.costMicroUsd,
      durationMs: t.durationMs,
      toolCalls: t.toolCalls,
      toolFailures: t.toolFailures,
      steps: t.steps,
      hallucinatedCalls: t.hallucinatedCalls,
      hallucinatedCallRate: t.hallucinatedCallRate,
      hallucinatedNames: t.hallucinatedNames,
      trajectoryDigest: t.trajectoryDigest,
    })),
  };
}

export type Report = ReturnType<typeof buildReport>;

// ─── report.html ─────────────────────────────────────────────────────────

const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Unscored is a word, never a number. */
const score = (value: number | null | undefined): string =>
  value === null || value === undefined ? '<span class="none">unscored</span>' : value.toFixed(3);

/** Unpriced is a word, never $0.00. */
const usd = (microUsd: number | null): string =>
  microUsd === null ? '<span class="none">unpriced</span>' : `$${(microUsd / 1e6).toFixed(4)}`;

const num = (value: number | null | undefined, digits = 3): string =>
  value === null || value === undefined ? '<span class="none">—</span>' : value.toFixed(digits);

function cellTable(report: Report, axis: string): string {
  const rows = report.cells
    .map((cell) => {
      const stat = cell.axes[axis];
      return `<tr><td>${esc(cell.armId)}</td><td>${esc(cell.taskId)}</td><td>${cell.n}</td>
        <td>${stat ? score(stat.mean) : score(null)}</td>
        <td>${stat ? num(stat.sd) : num(null)}</td></tr>`;
    })
    .join('\n');
  return `<table><thead><tr><th>arm</th><th>task</th><th>n</th><th>mean</th><th>sd</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function statsTable(stats: StatsResult): string {
  const arms = stats.arms
    .map(
      (a) =>
        `<tr><td>${esc(a.arm)}</td><td>${a.n_tasks}</td><td>${num(a.rate)}</td>
         <td>${a.ci ? `${num(a.ci[0])} – ${num(a.ci[1])}` : num(null)}</td><td>${num(a.icc)}</td></tr>`,
    )
    .join('\n');

  const pairs = stats.pairs
    .map(
      (p) =>
        `<tr><td>${esc(p.baseline)} → ${esc(p.arm)}</td><td>${num(p.difference)}</td>
         <td>${num(p.ci[0])} – ${num(p.ci[1])}</td><td>${num(p.p_value, 4)}</td>
         <td>${num(p.p_value_holm, 4)}</td><td>${p.shared_tasks}</td></tr>`,
    )
    .join('\n');

  return `
    <table><thead><tr><th>arm</th><th>tasks</th><th>rate</th><th>95% CI</th><th>ICC</th></tr></thead>
      <tbody>${arms}</tbody></table>
    ${
      pairs
        ? `<p class="note">Paired contrasts, resampled over tasks. Holm-corrected because every
             extra contrast is another chance to find something.</p>
           <table><thead><tr><th>contrast</th><th>difference</th><th>95% CI</th><th>p</th>
             <th>p (Holm)</th><th>shared tasks</th></tr></thead><tbody>${pairs}</tbody></table>`
        : ''
    }`;
}

export function renderHtml(report: Report): string {
  const errors = report.counts.errors;
  const exclusions = Object.entries(report.exclusions)
    .map(([rule, count]) => `<li><code>${esc(rule)}</code> — ${count}</li>`)
    .join('');

  const axes = [...new Set(report.cells.flatMap((c) => Object.keys(c.axes)))].sort();

  // The primary axis per trial, so an unscored trial is visible as unscored on
  // the row it belongs to rather than only as a smaller n in a cell mean.
  const primary = report.preRegistration.current.primaryMetric;
  const trials = report.trials
    .map(
      (t) => `<tr class="${t.verdict === 'ok' ? '' : 'err'}">
        <td><code>${esc(t.externalRef)}</code></td>
        <td>${esc(t.status ?? '—')}</td>
        <td>${t.verdict === 'ok' ? '<span class="ok">ok</span>' : `<span class="bad">${esc(t.verdict)}</span>`}</td>
        <td>${primary in t.axes ? score(t.axes[primary]) : score(null)}</td>
        <td>${num(t.hallucinatedCallRate)}</td>
        <td>${t.toolCalls}</td><td>${t.steps}</td>
        <td>${usd(t.costMicroUsd)}</td>
        <td><code class="dim">${esc((t.trajectoryDigest ?? '').slice(0, 12))}</code></td></tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(report.study.title)} — duva-bench</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --line:#ddd; --bad:#b00020; --ok:#0a6; --bg:#fff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --dim:#999; --line:#333; --bg:#111; } }
  body { font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         max-width:60rem; margin:0 auto; padding:2rem 1.25rem; color:var(--fg); background:var(--bg); }
  h1 { font-size:1.5rem; margin:0 0 .25rem; } h2 { font-size:1.1rem; margin:2.5rem 0 .5rem; }
  h3 { font-size:.95rem; margin:1.5rem 0 .4rem; color:var(--dim); font-weight:600; }
  code { font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .dim { color:var(--dim); } .none { color:var(--dim); font-style:italic; }
  .ok { color:var(--ok); } .bad { color:var(--bad); font-weight:600; }
  table { border-collapse:collapse; width:100%; margin:.5rem 0 1rem; font-size:14px; }
  th,td { text-align:left; padding:.35rem .6rem; border-bottom:1px solid var(--line); }
  th { color:var(--dim); font-weight:600; }
  tr.err td { opacity:.65; }
  .wrap { overflow-x:auto; }
  .banner { border-left:3px solid var(--bad); padding:.5rem .9rem; margin:1rem 0; }
  .note { color:var(--dim); font-size:13px; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:.15rem 1rem; margin:.5rem 0; }
  dt { color:var(--dim); } dd { margin:0; }
</style></head><body>

<h1>${esc(report.study.title)}</h1>
<p class="dim"><code>${esc(report.study.digest)}</code><br>collected ${esc(report.collectedAt)}</p>

<h2>Pre-registration</h2>
${
  report.preRegistration.amended
    ? `<div class="banner"><strong>Amended.</strong> The reading as registered is printed beside the
        current one; both digests are below, so either can be recomputed.</div>`
    : '<p class="note">Unchanged since registration.</p>'
}
<dl>
  <dt>primary metric</dt><dd>${esc(report.preRegistration.current.primaryMetric)}${
    report.preRegistration.amended
      ? ` <span class="dim">(registered: ${esc(report.preRegistration.registered.primaryMetric)})</span>`
      : ''
  }</dd>
  <dt>repetitions</dt><dd>${report.preRegistration.current.repetitions}${
    report.preRegistration.amended
      ? ` <span class="dim">(registered: ${report.preRegistration.registered.repetitions})</span>`
      : ''
  }</dd>
  <dt>digest</dt><dd><code>${esc(report.preRegistration.currentDigest.slice(0, 16))}</code>${
    report.preRegistration.amended
      ? ` <span class="dim">as registered: <code>${esc(report.preRegistration.registeredDigest.slice(0, 16))}</code></span>`
      : ''
  }</dd>
</dl>

<h2>Evidence</h2>
<dl>
  <dt>trials</dt><dd>${report.counts.trials} recorded, ${report.counts.included} included</dd>
  <dt>errors</dt><dd>${errors === 0 ? '<span class="ok">none</span>' : `<span class="bad">${errors}</span> excluded — a run ADP could not verify is an ERROR, never a zero`}</dd>
  <dt>missing</dt><dd>${report.counts.missing}</dd>
</dl>
${exclusions ? `<h3>Exclusions</h3><ul>${exclusions}</ul>` : ''}

<h2>Noise floor</h2>
<p class="note">Read this before any contrast. A difference smaller than the within-cell spread
is not a finding.</p>
${
  report.noiseFloors.length === 0
    ? '<p class="none">Not measurable — a floor needs at least one cell with repeated trials.</p>'
    : `<table><thead><tr><th>axis</th><th>pooled sd</th><th>cells</th></tr></thead><tbody>${report.noiseFloors
        .map((f) => `<tr><td>${esc(f.axis)}</td><td>${num(f.sd)}</td><td>${f.cells}</td></tr>`)
        .join('')}</tbody></table>`
}

<h2>Per axis</h2>
${
  axes.length === 0
    ? '<p class="none">No axis was scored.</p>'
    : axes.map((axis) => `<h3>${esc(axis)}</h3><div class="wrap">${cellTable(report, axis)}</div>`).join('')
}

<h2>Statistics</h2>
${
  report.statisticsUnavailable
    ? `<div class="banner"><strong>Not computed.</strong> ${esc(report.statisticsUnavailable)}</div>`
    : Object.entries(report.statistics)
        .map(([axis, stats]) => `<h3>${esc(axis)}</h3><div class="wrap">${statsTable(stats)}</div>`)
        .join('') || '<p class="none">No axis had enough paired data.</p>'
}

<h2>Cost</h2>
<dl>
  <dt>total</dt><dd>${usd(report.costLedger.totalMicroUsd)}</dd>
  <dt>priced trials</dt><dd>${report.costLedger.pricedTrials}</dd>
  <dt>unpriced trials</dt><dd>${report.costLedger.unpricedTrials}${
    report.costLedger.unpricedTrials > 0
      ? ' <span class="dim">— these vendors publish no rate; the total is a lower bound</span>'
      : ''
  }</dd>
</dl>

<h2>Arms</h2>
<div class="wrap"><table><thead><tr><th>arm</th><th>digest</th><th>harness</th><th>topology</th>
  <th>model</th><th>toolset</th></tr></thead><tbody>
${report.study.arms
  .map(
    (a) => `<tr><td>${esc(a.id)}</td><td><code class="dim">${esc(armDigestShort(a.digest))}</code></td>
      <td>${esc(a.harness)}</td><td>${esc(a.topology)}</td>
      <td>${esc(a.model.model ?? `${a.model.provider}:${a.model.tier ?? 'standard'}`)}</td>
      <td>${esc(a.toolset.name)}/${esc(a.toolset.docsGrade)}${a.toolset.twinSeed ? ' <span class="dim">twin</span>' : ''}</td></tr>`,
  )
  .join('')}
</tbody></table></div>

<h2>Trials</h2>
<div class="wrap"><table><thead><tr><th>external_ref</th><th>status</th><th>verify</th>
  <th>${esc(report.preRegistration.current.primaryMetric)}</th>
  <th>halluc. rate</th><th>tools</th><th>steps</th><th>cost</th><th>trajectory</th></tr></thead>
<tbody>${trials}</tbody></table></div>

</body></html>
`;
}

const armDigestShort = (digest: string): string => digest.slice(0, 12);
