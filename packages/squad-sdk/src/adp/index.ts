/**
 * ADP integration: record a Squad assignment as a durable, verifiable run.
 *
 * Squad already runs against ADP unmodified through `platform/github.ts` — ADP
 * emulates GitHub's API well enough that the `gh` CLI works when `GH_HOST`
 * points at it. This module covers what has no GitHub analogue: the run, the
 * trajectory behind it, and the eval that scores it.
 *
 * @module adp
 */

export * from './client.js';
export * from './recorder.js';
