/**
 * What `validate` and `digest` print.
 *
 * Both report *every* problem rather than the first: a spec with four mistakes
 * should cost one round trip, not four. And `digest` prints the pre-registration
 * in both readings whenever it has been amended, because an amendment a reader
 * has to go looking for is one they will not find.
 */

import { existsSync } from 'node:fs';

import { loadStudyFile, resolveFrom } from './study-file.js';
import {
  armDigest,
  preRegistrationReading,
  shortDigest,
  studyDigest,
  type Study,
} from './study.js';

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

function renderDigest(study: Study, path: string): string {
  const lines: string[] = [];
  const digest = studyDigest(study);

  lines.push(`study    ${study.title}`);
  lines.push(`digest   ${digest}`);
  lines.push(`short    ${shortDigest(digest)}`);
  lines.push('');
  lines.push('arms');
  for (const arm of study.arms) {
    const model = arm.model.model ?? `${arm.model.provider}:${arm.model.tier ?? 'standard'}`;
    lines.push(
      `  ${arm.id.padEnd(12)} ${shortDigest(armDigest(arm))}  ${arm.harness}  ${model}  ` +
        `tools=${arm.toolset.name}/${arm.toolset.docsGrade}  topology=${arm.topology}`,
    );
  }

  lines.push('');
  lines.push('tasks');
  for (const task of study.tasks) {
    lines.push(`  ${task.id.padEnd(12)} grader ${task.graderSha256.slice(0, 12)}`);
  }

  const reading = preRegistrationReading(study.preRegistration);
  lines.push('');
  lines.push('pre-registration');
  lines.push(`  primary metric   ${reading.current.primaryMetric}`);
  lines.push(`  repetitions      ${reading.current.repetitions}`);
  lines.push(`  exclusion rules  ${reading.current.exclusionRules.map((r) => r.id).join(', ') || '(none)'}`);
  lines.push(`  digest           ${reading.currentDigest}`);
  if (reading.amended) {
    // The pre-amendment reading is printed beside the current one, never
    // instead of it, so both remain computable from what is on the page.
    lines.push('');
    lines.push(`  amended ${reading.current.amendments.length}x — as registered:`);
    lines.push(`    primary metric ${reading.registered.primaryMetric}`);
    lines.push(`    repetitions    ${reading.registered.repetitions}`);
    lines.push(`    digest         ${reading.registeredDigest}`);
    for (const amendment of reading.current.amendments) {
      lines.push(
        `    ${amendment.at} ${amendment.field}: ${JSON.stringify(amendment.from)} -> ` +
          `${JSON.stringify(amendment.to)} (${amendment.reason})`,
      );
    }
  }

  lines.push('');
  lines.push(`trials   ${study.tasks.length} tasks x ${study.arms.length} arms x ${reading.current.repetitions} reps = ${study.tasks.length * study.arms.length * reading.current.repetitions}`);
  lines.push(`budget   $${study.budgetUsd.toFixed(2)}`);
  lines.push(`spec     ${path}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Missing referenced files are warnings, not schema errors.
 *
 * A spec is often written before its seeds exist, and refusing to validate it
 * would make `validate` useless exactly when it is most wanted. `existsSync`
 * rather than a read, because `seed` is a directory.
 */
function missingPaths(study: Study, path: string): string[] {
  const missing: string[] = [];
  for (const task of study.tasks) {
    for (const [label, target] of [
      ['goal', task.goal],
      ['seed', task.seed],
      ['grader', task.grader],
    ] as const) {
      if (!existsSync(resolveFrom(path, target))) missing.push(`${task.id}.${label}: ${target}`);
    }
  }
  return missing;
}

export function describeStudyFile(path: string, command: 'validate' | 'digest'): CommandOutput {
  let result;
  try {
    result = loadStudyFile(path);
  } catch (error) {
    return {
      code: 2,
      stdout: '',
      stderr: `duva-bench ${command}: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  if (!result.ok) {
    const lines = result.errors.map((e) => `  ${e.path}: ${e.message}`);
    return {
      code: 1,
      stdout: '',
      stderr: `duva-bench ${command}: ${result.errors.length} problem(s) in ${path}\n${lines.join('\n')}\n`,
    };
  }

  if (command === 'digest') return { code: 0, stdout: renderDigest(result.study, path), stderr: '' };

  const missing = missingPaths(result.study, path);
  const warnings = missing.length
    ? `\nwarning: ${missing.length} referenced path(s) not found:\n${missing.map((m) => `  ${m}`).join('\n')}\n`
    : '';
  return {
    code: 0,
    stdout: `ok — ${result.study.tasks.length} task(s), ${result.study.arms.length} arm(s), digest ${shortDigest(studyDigest(result.study))}\n${warnings}`,
    stderr: '',
  };
}
