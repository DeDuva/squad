#!/usr/bin/env node
/**
 * Workstation tools smoke test — exercises every tool end-to-end with real
 * fs/child_process. No API key or agent loop required.
 *
 * Usage: node scripts/smoke-workstation.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkstationTools } from '../packages/squad-sdk/dist/tools/workstation.js';

const IS_WINDOWS = process.platform === 'win32';

const ctx = {
  sessionId: 'smoke',
  toolCallId: 'smoke-1',
  toolName: '',
  arguments: {},
};

let passed = 0;
let failed = 0;

function check(name, result, expectFn) {
  try {
    expectFn(result);
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${name}`);
    console.error(`      ${err.message}`);
    console.error(`      result: ${JSON.stringify(result, null, 2).split('\n').join('\n      ')}`);
    failed++;
  }
}

const tmpDir = await mkdtemp(join(tmpdir(), 'squad-ws-smoke-'));
console.log(`\nWorkstation smoke test  (tmpDir: ${tmpDir})\n`);

try {
  const tools = createWorkstationTools({ rootDir: tmpDir });
  const get = name => tools.find(t => t.name === name);

  // ── workstation_write_file ────────────────────────────────────────────────
  console.log('workstation_write_file');
  const write = get('workstation_write_file');

  const writeResult = await write.handler(
    { path: join(tmpDir, 'hello.txt'), content: 'Hello, workstation!\nLine 2.' },
    ctx,
  );
  check('writes a new file → success', writeResult, r => {
    if (r.resultType !== 'success') throw new Error(`resultType=${r.resultType}`);
  });

  const overwriteResult = await write.handler(
    { path: join(tmpDir, 'hello.txt'), content: 'Overwritten.' },
    ctx,
  );
  check('overwrites existing file → success', overwriteResult, r => {
    if (r.resultType !== 'success') throw new Error(`resultType=${r.resultType}`);
  });

  const escapedResult = await write.handler(
    { path: join(tmpDir, '..', 'escape.txt'), content: 'bad' },
    ctx,
  );
  check('rejects path escaping rootDir → failure', escapedResult, r => {
    if (r.resultType !== 'failure') throw new Error(`resultType=${r.resultType} (expected failure)`);
    if (!['EACCES', 'ENOENT'].includes(r.error)) throw new Error(`error=${r.error}`);
  });

  // ── workstation_read_file ─────────────────────────────────────────────────
  console.log('\nworkstation_read_file');
  const read = get('workstation_read_file');

  // Write a fresh known file
  await write.handler({ path: join(tmpDir, 'read-me.txt'), content: 'alpha\nbeta\ngamma\ndelta\nepsilon' }, ctx);

  const readResult = await read.handler({ path: join(tmpDir, 'read-me.txt') }, ctx);
  check('reads full file contents', readResult, r => {
    if (r.resultType !== 'success') throw new Error(`resultType=${r.resultType}`);
    if (!r.textResultForLlm.includes('alpha')) throw new Error('missing "alpha"');
    if (!r.textResultForLlm.includes('epsilon')) throw new Error('missing "epsilon"');
  });

  const rangeResult = await read.handler(
    { path: join(tmpDir, 'read-me.txt'), start_line: 2, end_line: 4 },
    ctx,
  );
  check('reads line range (2–4)', rangeResult, r => {
    if (r.resultType !== 'success') throw new Error(`resultType=${r.resultType}`);
    if (!r.textResultForLlm.includes('beta')) throw new Error('missing "beta"');
    if (!r.textResultForLlm.includes('delta')) throw new Error('missing "delta"');
    if (r.textResultForLlm.includes('alpha')) throw new Error('should not include "alpha" (line 1)');
  });

  const missingResult = await read.handler({ path: join(tmpDir, 'nope.txt') }, ctx);
  check('returns ENOENT for missing file', missingResult, r => {
    if (r.resultType !== 'failure') throw new Error(`resultType=${r.resultType}`);
    if (r.error !== 'ENOENT') throw new Error(`error=${r.error}`);
  });

  // ── workstation_list_dir ──────────────────────────────────────────────────
  console.log('\nworkstation_list_dir');
  const list = get('workstation_list_dir');

  // Add a subdirectory
  await write.handler({ path: join(tmpDir, 'sub', 'nested.ts'), content: '// nested' }, ctx);

  const flatResult = await list.handler({ path: tmpDir }, ctx);
  check('lists top-level entries', flatResult, r => {
    if (r.resultType !== 'success') throw new Error(`resultType=${r.resultType}`);
    if (!r.textResultForLlm.includes('hello.txt')) throw new Error('missing hello.txt');
    if (!r.textResultForLlm.includes('sub')) throw new Error('missing sub/');
  });

  const recursiveResult = await list.handler({ path: tmpDir, recursive: true }, ctx);
  check('recursive listing includes nested file', recursiveResult, r => {
    if (r.resultType !== 'success') throw new Error(`resultType=${r.resultType}`);
    if (!r.textResultForLlm.includes('nested.ts')) throw new Error('missing nested.ts');
  });

  // ── workstation_find_files ────────────────────────────────────────────────
  console.log('\nworkstation_find_files');
  const find = get('workstation_find_files');

  const findResult = await find.handler({ pattern: '**/*.ts', cwd: tmpDir }, ctx);
  check('finds .ts files recursively', findResult, r => {
    if (r.resultType !== 'success') throw new Error(`resultType=${r.resultType}`);
    if (!r.textResultForLlm.includes('nested.ts')) throw new Error('missing nested.ts');
  });

  const noMatchResult = await find.handler({ pattern: '*.py', cwd: tmpDir }, ctx);
  check('returns "no matches" for unmatched pattern', noMatchResult, r => {
    if (r.resultType !== 'success') throw new Error(`resultType=${r.resultType}`);
    if (!r.textResultForLlm.includes('no matches')) throw new Error('missing "no matches"');
  });

  // ── workstation_bash ──────────────────────────────────────────────────────
  console.log('\nworkstation_bash');
  const bash = get('workstation_bash');

  const echoResult = await bash.handler(
    { command: IS_WINDOWS ? 'echo hello from bash' : 'echo "hello from bash"' },
    ctx,
  );
  check('runs echo command → exit 0', echoResult, r => {
    if (r.resultType !== 'success') throw new Error(`resultType=${r.resultType}`);
    if (!r.textResultForLlm.includes('hello from bash')) throw new Error('missing echo output');
    if (!r.textResultForLlm.includes('Exit code: 0')) throw new Error('missing exit code');
  });

  const cwdResult = await bash.handler(
    { command: IS_WINDOWS ? 'cd' : 'pwd', cwd: tmpDir },
    ctx,
  );
  check('cwd argument respected', cwdResult, r => {
    if (r.resultType !== 'success') throw new Error(`resultType=${r.resultType}`);
    // Output should contain part of the tmpDir path
    const out = r.textResultForLlm.toLowerCase().replace(/\\/g, '/');
    const expected = tmpDir.toLowerCase().replace(/\\/g, '/').split('/').at(-1);
    if (!out.includes(expected)) throw new Error(`cwd not in output: ${r.textResultForLlm}`);
  });

  const failResult = await bash.handler(
    { command: IS_WINDOWS ? 'exit 1' : 'exit 1' },
    ctx,
  );
  check('non-zero exit → failure result', failResult, r => {
    if (r.resultType !== 'failure') throw new Error(`resultType=${r.resultType}`);
  });

  const timeoutResult = await bash.handler(
    { command: IS_WINDOWS ? 'ping -n 10 127.0.0.1 > NUL' : 'sleep 5', timeout_ms: 300 },
    ctx,
  );
  check('timeout enforcement works', timeoutResult, r => {
    if (r.resultType !== 'failure') throw new Error(`resultType=${r.resultType}`);
    if (r.error !== 'timeout') throw new Error(`error=${r.error} (expected timeout)`);
  });

  const secretKey = 'SMOKE_TEST_SECRET_12345';
  process.env[secretKey] = 'super-secret-value';
  const stripResult = await bash.handler(
    { command: IS_WINDOWS ? `echo %${secretKey}%` : `echo $${secretKey}` },
    ctx,
  );
  delete process.env[secretKey];
  check('sensitive env vars stripped', stripResult, r => {
    if (r.textResultForLlm.includes('super-secret-value'))
      throw new Error('secret leaked into output');
  });

} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`  ${passed} passed  |  ${failed} failed`);
console.log('─'.repeat(48));
if (failed > 0) process.exit(1);
