/**
 * Reading a study off disk.
 *
 * YAML and JSON both, and the format is deliberately not part of the study's
 * identity: the same experiment written either way digests the same, because
 * the digest is taken over the normalized value rather than the file's bytes.
 *
 * `grader.sha256` is computed here rather than trusted from the file. A study
 * that could declare its own grader digest could declare a stale one, and the
 * whole point of the field is that changing the grader changes the study.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { parseStudy, type ParseResult } from './study.js';

/** Resolve a study-relative path against the study file's own directory. */
export function resolveFrom(studyPath: string, target: string): string {
  return isAbsolute(target) ? target : resolve(dirname(resolve(studyPath)), target);
}

export function graderSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface LoadOptions {
  /**
   * Fill in each task's `graderSha256` from the grader on disk.
   *
   * On by default: the digest is a fact about the file, and a study is easier
   * to trust when it cannot restate that fact incorrectly. Turned off when
   * validating a spec whose graders are not present.
   */
  hashGraders?: boolean;
}

/**
 * Parse a study file. Never throws for bad content — only for an unreadable
 * file, which is a different kind of problem and deserves to look like one.
 */
export function loadStudyFile(path: string, options: LoadOptions = {}): ParseResult {
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    // `yaml` parses JSON too — JSON is a YAML subset — so one path covers both.
    raw = parseYaml(text);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: '(file)', message: error instanceof Error ? error.message : String(error) }],
    };
  }

  if (options.hashGraders !== false && raw && typeof raw === 'object') {
    const tasks = (raw as { tasks?: unknown }).tasks;
    if (Array.isArray(tasks)) {
      for (const task of tasks) {
        if (!task || typeof task !== 'object') continue;
        const entry = task as { grader?: unknown; graderSha256?: unknown };
        if (typeof entry.grader !== 'string') continue;
        try {
          entry.graderSha256 = graderSha256(resolveFrom(path, entry.grader));
        } catch {
          // Left as written. If it is absent or malformed the schema says so,
          // which is a better error than one about a missing file the user
          // never mentioned.
        }
      }
    }
  }

  return parseStudy(raw);
}
