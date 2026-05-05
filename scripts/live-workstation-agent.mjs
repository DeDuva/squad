#!/usr/bin/env node
/**
 * Live workstation agent session — Option A validation.
 *
 * Starts a real GeminiSession with workstation tools enabled, instructs the
 * agent to perform concrete file and shell operations, then asserts the side
 * effects actually happened on disk.
 *
 * Requirements:
 *   GEMINI_API_KEY environment variable must be set.
 *
 * Usage:
 *   GEMINI_API_KEY=<key> node scripts/live-workstation-agent.mjs
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GeminiSession } from '../packages/squad-sdk/dist/adapter/gemini-client.js';
import { createWorkstationTools } from '../packages/squad-sdk/dist/tools/workstation.js';

const IS_WINDOWS = process.platform === 'win32';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('❌  GEMINI_API_KEY is not set.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(label, okFn) {
  try {
    okFn();
    console.log(`  ✅  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌  ${label}: ${err.message}`);
    failed++;
  }
}

const tmpDir = await mkdtemp(join(tmpdir(), 'squad-live-'));
console.log(`\nLive workstation agent session`);
console.log(`tmpDir: ${tmpDir}\n`);

try {
  const tools = createWorkstationTools({ rootDir: tmpDir });
  const toolEvents = [];

  const session = new GeminiSession(GEMINI_API_KEY, {
    tools,
    model: 'gemini-2.5-flash',
  });

  // Capture every tool_call and tool_result event so we can report them
  session.on('tool_call', e => {
    toolEvents.push({ type: 'call', name: e.toolName, args: e.arguments });
    console.log(`  → tool_call: ${e.toolName}(${JSON.stringify(e.arguments ?? {}).slice(0, 120)})`);
  });
  session.on('tool_result', e => {
    toolEvents.push({ type: 'result', name: e.toolName, resultType: e.result?.resultType });
    console.log(`  ← tool_result: ${e.toolName} → ${e.result?.resultType}`);
  });

  // ── All four tasks in a single turn (minimises API calls) ───────────────
  const bashFile = join(tmpDir, 'bash-proof.txt');
  const bashCmd = IS_WINDOWS
    ? `echo proof-of-bash > "${bashFile}"`
    : `echo proof-of-bash > "${bashFile}"`;

  console.log('Sending combined task prompt (4 tool calls expected)…');
  await session.sendMessage({
    prompt: [
      `Working directory: ${tmpDir}. Perform ALL four steps below in order, calling each tool once:`,
      `1. workstation_write_file — write "hello from the agent" to "${join(tmpDir, 'agent-output.txt')}"`,
      `2. workstation_read_file  — read "${join(tmpDir, 'agent-output.txt')}"`,
      `3. workstation_list_dir   — list "${tmpDir}"`,
      `4. workstation_bash       — run: ${bashCmd}`,
      `Call each tool in sequence. Do not explain, just call the tools.`,
    ].join(' '),
  });

  console.log('');

  // ── Assertions ───────────────────────────────────────────────────────────
  check(
    'agent-output.txt exists on disk',
    () => { if (!existsSync(join(tmpDir, 'agent-output.txt'))) throw new Error('file missing'); },
  );
  if (existsSync(join(tmpDir, 'agent-output.txt'))) {
    const content = await readFile(join(tmpDir, 'agent-output.txt'), 'utf-8');
    check(
      'agent-output.txt contains expected text',
      () => { if (!content.includes('hello from the agent')) throw new Error(`got: ${content}`); },
    );
  }

  check(
    'agent called workstation_read_file',
    () => {
      if (!toolEvents.some(e => e.type === 'call' && e.name === 'workstation_read_file'))
        throw new Error('workstation_read_file was not called');
    },
  );

  check(
    'agent called workstation_list_dir',
    () => {
      if (!toolEvents.some(e => e.type === 'call' && e.name === 'workstation_list_dir'))
        throw new Error('workstation_list_dir was not called');
    },
  );

  check(
    'bash-proof.txt created by shell command',
    () => { if (!existsSync(bashFile)) throw new Error('file not created by bash'); },
  );

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\nTool events during session: ${toolEvents.length}`);
  console.log(`  calls:   ${toolEvents.filter(e => e.type === 'call').length}`);
  console.log(`  results: ${toolEvents.filter(e => e.type === 'result').length}`);

} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`  ${passed} passed  |  ${failed} failed`);
console.log('─'.repeat(48));
if (failed > 0) process.exit(1);
