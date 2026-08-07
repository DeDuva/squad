/**
 * Read a study back out of ADP and write down what it found.
 *
 * Every number here comes from `runs/compare`, which is the same source the
 * exec summary uses — the study stores no scores of its own, so there is
 * nothing for this to disagree with. What it adds is the thing one run cannot
 * have: repeats, and therefore a noise floor to read every other difference
 * against.
 *
 *   SQUAD_LAB_ADP_TOKEN=… npm run variance-report -w @deduvafork/squad-lab -- \
 *     --manifest=/path/to/manifest-xxx.json --out=/path/to/report.md
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { compareRuns, type AdpEndpoint } from '../src/adp.js';
import {
  axesDisagree,
  cells,
  harnessContrasts,
  modelSpread,
  noiseFloor,
  resourceContrasts,
  type Cell,
  type RunObservation,
} from '../src/variance.js';

const arg = (name: string, fallback?: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = hit ? hit.slice(name.length + 3) : undefined;
  if (value === undefined && fallback === undefined) throw new Error(`missing required --${name}=`);
  return value ?? fallback!;
};

interface Manifest {
  startedAt: string;
  repeats: number;
  experiments: { task: string; id: string; intentId: string; repo: string }[];
}

const n2 = (v: number | null | undefined, digits = 3): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';

const money = (microUsd: number | null | undefined): string =>
  typeof microUsd === 'number' && Number.isFinite(microUsd) && microUsd > 0
    ? `$${(microUsd / 1_000_000).toFixed(4)}`
    : 'unpriced';

/** `mean ± sd` with the sd omitted when a single run cannot have one. */
const spread = (s: { mean: number; sd: number | null } | null, digits = 3): string =>
  !s ? '—' : s.sd === null ? n2(s.mean, digits) : `${n2(s.mean, digits)} ± ${n2(s.sd, digits)}`;

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(arg('manifest'), 'utf8')) as Manifest;
  const token = process.env['SQUAD_LAB_ADP_TOKEN'];
  if (!token) throw new Error('SQUAD_LAB_ADP_TOKEN is not set');
  const baseUrl = arg('adp-url', 'http://127.0.0.1:8793');
  const owner = arg('owner', 'lab');

  const observations: RunObservation[] = [];
  const axisNames = new Set<string>();
  let unlabelled = 0;

  for (const experiment of manifest.experiments) {
    const ep: AdpEndpoint = { baseUrl, token, owner, repo: experiment.repo };
    const { runs } = await compareRuns(ep, experiment.intentId);
    for (const row of runs) {
      const labels = row.labels ?? {};
      // Model and harness are read off the run's own attested labels rather
      // than parsed out of the variant id: the id is a convention this script
      // chose, the labels are what ADP signed into the run predicate.
      const model = labels['model'];
      const harness = labels['harness_impl'];
      if (!model || !harness) { unlabelled += 1; continue; }

      const axes: Record<string, number | null> = {};
      for (const e of row.evals ?? (row.eval ? [row.eval] : [])) {
        axes[e.name] = e.score;
        axisNames.add(e.name);
      }
      observations.push({
        task: experiment.task,
        model,
        harness,
        variantId: labels['variant'] ?? row.externalRef ?? row.runId,
        axes,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        // ADP sums a missing cost as 0. A vendor with no published rates is
        // unpriced, and calling that free would make it the cheapest cell.
        costMicroUsd: row.costMicroUsd > 0 ? row.costMicroUsd : null,
        toolCalls: row.toolCalls,
        toolFailures: row.toolFailures,
        durationMs: row.durationMs,
      });
    }
  }

  // A model whose provider refused most of its requests contributes noise that
  // is not the system's noise, and it lands in the denominator of every
  // contrast. Excluding it is a stated choice with a stated reason, not a
  // quiet filter — the excluded cells are still printed above.
  const excluded = arg('exclude-models', '').split(',').map((s) => s.trim()).filter(Boolean);

  const axes = [...axisNames].sort();
  const cs = cells(observations, axes);
  const kept = excluded.length > 0 ? cs.filter((c) => !excluded.includes(c.model)) : cs;
  const lines: string[] = [];
  const say = (s = '') => lines.push(s);

  say(`# Variance across models and harnesses`);
  say();
  say(`${observations.length} runs · ${manifest.experiments.length} task(s) · ${cs.length} cells · ${manifest.repeats} repeats per cell`);
  say(`Started ${manifest.startedAt}. Every figure below comes from ADP's \`runs/compare\`.`);
  if (unlabelled > 0) say(`\n> ${unlabelled} run(s) carried no model/harness label and are excluded.`);
  say();

  // --- the floor, first, because everything else is read against it --------
  say(`## The noise floor`);
  say();
  say(`How much a score moves when nothing changes: the same model, harness and task,`);
  say(`run again. Pooled within-cell standard deviation.`);
  say();
  say(`| axis | within-cell sd | cells contributing |`);
  say(`|---|---|---|`);
  for (const axis of axes) {
    const floor = noiseFloor(kept, axis);
    say(`| \`${axis}\` | ${floor ? n2(floor.sd) : '—'} | ${floor?.cells ?? 0} |`);
  }
  if (excluded.length > 0) {
    say();
    say(`> Excluding ${excluded.map((m) => `\`${m}\``).join(', ')} from every contrast below.`);
    say(`> Its runs were refused by the provider rather than answered badly, and noise`);
    say(`> that is the provider's rather than the system's still lands in the denominator`);
    say(`> of every effect measured against it. The excluded cells remain in the table above.`);
  }
  say();

  // --- cells ---------------------------------------------------------------
  say(`## Every cell`);
  say();
  say(`\`mean ± sd\` over repeats.`);
  say();
  say(`A cell with unscored runs is averaging over its survivors. Those rows are`);
  say(`marked, and the mean beside the mark is conditional on surviving.`);
  say();
  say(`| task | model | harness | scored/n | ${axes.map((a) => `\`${a}\``).join(' | ')} | tokens in | cost | tools |`);
  say(`|---|---|---|---|${axes.map(() => '---').join('|')}|---|---|---|`);
  for (const c of cs) {
    const cost = c.costMicroUsd ? money(c.costMicroUsd.mean) : 'unpriced';
    const survival = c.unscored > 0 ? `**${c.scored}/${c.n}**` : `${c.scored}/${c.n}`;
    say(
      `| ${c.task} | ${c.model} | ${c.harness} | ${survival} | ` +
        `${axes.map((a) => spread(c.byAxis[a] ?? null)).join(' | ')} | ` +
        `${c.tokensIn ? Math.round(c.tokensIn.mean).toLocaleString() : '—'} | ${cost} | ` +
        `${c.toolCalls ? n2(c.toolCalls.mean, 1) : '—'} |`,
    );
  }
  say();

  const partial = cs.filter((c) => c.unscored > 0);
  if (partial.length > 0) {
    say(`> **${partial.length} cell(s) lost runs.** ` +
      partial.map((c) => `${c.model}/${c.harness} on ${c.task} (${c.unscored} of ${c.n})`).join('; ') +
      `. A run can end unscored because the agent delivered nothing, or because the provider refused to serve it — ` +
      `a quota or rate-limit error is an absence of a measurement rather than a low one, and a cell holding either ` +
      `should not be read as a score for that model or that harness.`);
    say();
  }

  // --- harness ------------------------------------------------------------
  say(`## The harness effect`);
  say();
  say(`Same model, same task, same charter, tools, budget and rubric — only the`);
  say(`agent loop differs. \`delta\` is \`ai-sdk\` minus \`squad-native\`; \`vs noise\` is`);
  say(`its size in units of the within-cell sd above. Under 1 is indistinguishable`);
  say(`from a repeat.`);
  for (const axis of axes) {
    const contrasts = harnessContrasts(kept, axis);
    if (contrasts.length === 0) continue;
    say();
    say(`### \`${axis}\``);
    say();
    say(`| task | model | squad-native | ai-sdk | delta | vs noise |`);
    say(`|---|---|---|---|---|---|`);
    for (const c of contrasts) {
      say(`| ${c.task} | ${c.holding} | ${n2(c.meanA)} | ${n2(c.meanB)} | ${c.delta >= 0 ? '+' : ''}${n2(c.delta)} | ${c.vsNoise === null ? '—' : `${n2(c.vsNoise, 1)}x`} |`);
    }
  }
  say();

  // --- what a run consumed, which is where the differences actually are ----
  say(`## The harness effect on what a run consumed`);
  say();
  say(`The same contrast applied to resources rather than scores, as a ratio —`);
  say(`\`ai-sdk\` over \`squad-native\`. Not measured against the noise floor, which`);
  say(`is computed on bounded scores and means nothing here.`);
  for (const metric of ['tokensIn', 'costMicroUsd', 'toolCalls', 'durationMs'] as const) {
    const contrasts = resourceContrasts(kept, metric);
    if (contrasts.length === 0) continue;
    say();
    say(`### \`${metric}\``);
    say();
    say(`| task | model | squad-native | ai-sdk | ratio |`);
    say(`|---|---|---|---|---|`);
    for (const c of contrasts) {
      const fmt = (v: number) =>
        metric === 'costMicroUsd' ? money(v) : metric === 'durationMs' ? `${(v / 1000).toFixed(0)}s` : Math.round(v).toLocaleString();
      say(`| ${c.task} | ${c.model} | ${fmt(c.meanA)} | ${fmt(c.meanB)} | ${n2(c.ratio, 2)}x |`);
    }
  }
  say();

  // --- model --------------------------------------------------------------
  say(`## The model effect`);
  say();
  say(`Best cell mean minus worst, with the harness and task held fixed.`);
  for (const axis of axes) {
    const spreads = modelSpread(kept, axis);
    if (spreads.length === 0) continue;
    say();
    say(`### \`${axis}\``);
    say();
    say(`| task | harness | ordering | range | vs noise |`);
    say(`|---|---|---|---|---|`);
    for (const s of spreads) {
      const order = s.byModel.map((m) => `${m.model} ${n2(m.mean, 2)}`).join(' > ');
      say(`| ${s.task} | ${s.harness} | ${order} | ${n2(s.range)} | ${s.vsNoise === null ? '—' : `${n2(s.vsNoise, 1)}x`} |`);
    }
  }
  say();

  // --- do the axes agree? -------------------------------------------------
  say(`## Do the axes agree?`);
  say();
  say(`A disagreement that survives repeats is the finding a single number cannot carry.`);
  say();
  say(`| axis A | axis B | same ordering? |`);
  say(`|---|---|---|`);
  for (let i = 0; i < axes.length; i += 1) {
    for (let j = i + 1; j < axes.length; j += 1) {
      const disagree = axesDisagree(kept, axes[i]!, axes[j]!);
      say(`| \`${axes[i]}\` | \`${axes[j]}\` | ${disagree ? '**no**' : 'yes'} |`);
    }
  }
  say();

  const out = arg('out', '');
  const text = lines.join('\n');
  if (out) {
    writeFileSync(out, `${text}\n`);
    console.log(`wrote ${out}`);
  } else {
    console.log(text);
  }

  // A compact console digest, so a run in a terminal says something without
  // opening the file.
  console.log(`\n${observations.length} runs, ${cs.length} cells`);
  for (const axis of axes) {
    const floor = noiseFloor(kept, axis);
    console.log(`  ${axis.padEnd(12)} noise sd=${floor ? n2(floor.sd) : '—'}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
