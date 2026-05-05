/**
 * Workstation tool-call pipeline integration test.
 *
 * Validates the full path from "LLM returns a tool call" → tool executes for
 * real → result is fed back to the LLM → session completes. The LLM layer is
 * mocked via vi.stubGlobal('fetch') so no API key or network access is needed.
 * Workstation tool handlers run against a real tmpDir with actual fs/child_process.
 *
 * This gives CI confidence that the plumbing between GeminiSession ↔ ToolRegistry
 * ↔ workstation tools works correctly without the non-determinism of a live model.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiSession } from '../packages/squad-sdk/dist/adapter/gemini-client.js';
import type { SquadSessionConfig, SquadTool } from '@deduvafork/squad-sdk/adapter';
import { createWorkstationTools } from '@deduvafork/squad-sdk/workstation-tools';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// SSE helpers (same pattern as gemini-session-hooks.test.ts)
// ---------------------------------------------------------------------------

function sseChunk(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function makeStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Terminates cleanly after the tool response round. */
const TEXT_TERMINATOR = makeStream(
  sseChunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }] }),
  sseChunk({ usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 3 } }),
);

/**
 * Build a fetch mock that returns `toolCallStream` on the first call and
 * `TEXT_TERMINATOR` on all subsequent calls (the post-tool-result continuation).
 */
function fetchReturning(toolCallStream: ReadableStream<Uint8Array>) {
  let calls = 0;
  return vi.fn().mockImplementation(() => {
    calls++;
    return Promise.resolve({
      ok: true,
      status: 200,
      body: calls === 1 ? toolCallStream : TEXT_TERMINATOR,
    });
  });
}

function toolCallStream(toolName: string, args: Record<string, unknown>) {
  return makeStream(
    sseChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: toolName, args } }] } }] }),
    sseChunk({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
  );
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'squad-pipeline-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeSession(tools: SquadTool<any>[]) {
  return new GeminiSession('fake-key', { tools } as SquadSessionConfig);
}

// ---------------------------------------------------------------------------
// Pipeline tests — one tool per describe block
// ---------------------------------------------------------------------------

describe('workstation tool-call pipeline — write + read', () => {
  it('workstation_write_file: LLM tool call creates file on disk', async () => {
    const tools = createWorkstationTools({ rootDir: tmpDir });
    vi.stubGlobal('fetch', fetchReturning(toolCallStream('workstation_write_file', {
      path: join(tmpDir, 'hello.txt'),
      content: 'written by agent',
    })));

    await makeSession(tools).sendMessage({ prompt: 'write a file' });

    expect(existsSync(join(tmpDir, 'hello.txt'))).toBe(true);
    expect(await readFile(join(tmpDir, 'hello.txt'), 'utf-8')).toBe('written by agent');
  });

  it('workstation_write_file: path-traversal attempt is blocked, file NOT created', async () => {
    const tools = createWorkstationTools({ rootDir: tmpDir });
    vi.stubGlobal('fetch', fetchReturning(toolCallStream('workstation_write_file', {
      path: join(tmpDir, '..', 'evil.txt'),
      content: 'escaped',
    })));

    // Session should complete without throwing — the tool returns a failure result
    // which the (mocked) LLM receives and then says "Done."
    await makeSession(tools).sendMessage({ prompt: 'write outside root' });

    expect(existsSync(join(tmpDir, '..', 'evil.txt'))).toBe(false);
  });

  it('workstation_read_file: LLM tool call reads file contents', async () => {
    // Pre-seed a file
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(tmpDir, 'seed.txt'), 'seed content', 'utf-8');

    const readResultSpy = vi.fn();
    const tools = createWorkstationTools({ rootDir: tmpDir });

    // Wrap the read tool to capture its result
    const readTool = tools.find(t => t.name === 'workstation_read_file')!;
    const originalHandler = readTool.handler.bind(readTool);
    readTool.handler = async (args, ctx) => {
      const result = await originalHandler(args, ctx);
      readResultSpy(result);
      return result;
    };

    vi.stubGlobal('fetch', fetchReturning(toolCallStream('workstation_read_file', {
      path: join(tmpDir, 'seed.txt'),
    })));

    await makeSession(tools).sendMessage({ prompt: 'read the file' });

    expect(readResultSpy).toHaveBeenCalledOnce();
    const result = readResultSpy.mock.calls[0][0] as any;
    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('seed content');
  });
});

describe('workstation tool-call pipeline — list + find', () => {
  it('workstation_list_dir: LLM tool call lists directory', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(tmpDir, 'alpha.ts'), '', 'utf-8');
    await writeFile(join(tmpDir, 'beta.ts'), '', 'utf-8');

    const listResultSpy = vi.fn();
    const tools = createWorkstationTools({ rootDir: tmpDir });
    const listTool = tools.find(t => t.name === 'workstation_list_dir')!;
    const originalHandler = listTool.handler.bind(listTool);
    listTool.handler = async (args, ctx) => {
      const result = await originalHandler(args, ctx);
      listResultSpy(result);
      return result;
    };

    vi.stubGlobal('fetch', fetchReturning(toolCallStream('workstation_list_dir', {
      path: tmpDir,
    })));

    await makeSession(tools).sendMessage({ prompt: 'list the directory' });

    expect(listResultSpy).toHaveBeenCalledOnce();
    const result = listResultSpy.mock.calls[0][0] as any;
    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('alpha.ts');
    expect(result.textResultForLlm).toContain('beta.ts');
  });

  it('workstation_find_files: LLM tool call finds matching files', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'index.ts'), '', 'utf-8');
    await writeFile(join(tmpDir, 'README.md'), '', 'utf-8');

    const findResultSpy = vi.fn();
    const tools = createWorkstationTools({ rootDir: tmpDir });
    const findTool = tools.find(t => t.name === 'workstation_find_files')!;
    const originalHandler = findTool.handler.bind(findTool);
    findTool.handler = async (args, ctx) => {
      const result = await originalHandler(args, ctx);
      findResultSpy(result);
      return result;
    };

    vi.stubGlobal('fetch', fetchReturning(toolCallStream('workstation_find_files', {
      pattern: '**/*.ts',
      cwd: tmpDir,
    })));

    await makeSession(tools).sendMessage({ prompt: 'find TypeScript files' });

    expect(findResultSpy).toHaveBeenCalledOnce();
    const result = findResultSpy.mock.calls[0][0] as any;
    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('index.ts');
    expect(result.textResultForLlm).not.toContain('README.md');
  });
});

describe('workstation tool-call pipeline — bash', () => {
  const IS_WINDOWS = process.platform === 'win32';

  it('workstation_bash: LLM tool call runs command and captures output', async () => {
    const bashResultSpy = vi.fn();
    const tools = createWorkstationTools({ rootDir: tmpDir });
    const bashTool = tools.find(t => t.name === 'workstation_bash')!;
    const originalHandler = bashTool.handler.bind(bashTool);
    bashTool.handler = async (args, ctx) => {
      const result = await originalHandler(args, ctx);
      bashResultSpy(result);
      return result;
    };

    vi.stubGlobal('fetch', fetchReturning(toolCallStream('workstation_bash', {
      command: IS_WINDOWS ? 'echo pipeline-ok' : 'echo pipeline-ok',
    })));

    await makeSession(tools).sendMessage({ prompt: 'run a command' });

    expect(bashResultSpy).toHaveBeenCalledOnce();
    const result = bashResultSpy.mock.calls[0][0] as any;
    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('pipeline-ok');
    expect(result.textResultForLlm).toContain('Exit code: 0');
  });

  it('workstation_bash: tool result is returned to the LLM in function response', async () => {
    const tools = createWorkstationTools({ rootDir: tmpDir });

    // Capture what fetch receives on the second call (the function response round)
    const fetchBodies: string[] = [];
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      calls++;
      if (calls > 1 && init?.body) {
        fetchBodies.push(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
      }
      return {
        ok: true,
        status: 200,
        body: calls === 1
          ? toolCallStream('workstation_bash', { command: IS_WINDOWS ? 'echo hello-llm' : 'echo hello-llm' })
          : TEXT_TERMINATOR,
      };
    }));

    await makeSession(tools).sendMessage({ prompt: 'run command and return result to LLM' });

    // The second fetch call should contain a functionResponse with the tool output
    expect(fetchBodies.length).toBeGreaterThanOrEqual(1);
    const body = fetchBodies[0];
    expect(body).toContain('functionResponse');
    expect(body).toContain('workstation_bash');
    expect(body).toContain('hello-llm');
  });
});
