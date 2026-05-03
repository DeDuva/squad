/**
 * Tests for the workstation tool bundle.
 *
 * All tests use real child_process and node:fs — no mocks — because workstation
 * tools are integration-level by design and mocking would miss the gap.
 * Temporary files are written to os.tmpdir() and cleaned up in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '@bradygaster/squad-sdk/tools';
import { createWorkstationTools } from '@bradygaster/squad-sdk/workstation-tools';

const IS_WINDOWS = process.platform === 'win32';

const invocationCtx = {
  sessionId: 'test-session',
  toolCallId: 'call-1',
  toolName: '',
  arguments: {},
};

// ---------------------------------------------------------------------------
// Shared temp dir setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `squad-ws-test-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// workstation_bash
// ---------------------------------------------------------------------------

describe('workstation_bash', () => {
  function getBashTool() {
    const tools = createWorkstationTools();
    return tools.find(t => t.name === 'workstation_bash')!;
  }

  it('returns stdout and exit code 0 for a successful command', async () => {
    const tool = getBashTool();
    const cmd = IS_WINDOWS ? 'echo hello' : 'echo hello';
    const result = await tool.handler({ command: cmd }, invocationCtx) as any;

    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('Exit code: 0');
    expect(result.textResultForLlm).toContain('hello');
    expect(result.toolTelemetry.exitCode).toBe(0);
  });

  it('returns non-zero exit code for a failing command', async () => {
    const tool = getBashTool();
    const cmd = IS_WINDOWS ? 'exit 1' : 'exit 1';
    const result = await tool.handler({ command: cmd }, invocationCtx) as any;

    expect(result.resultType).toBe('failure');
    expect(result.textResultForLlm).toMatch(/Exit code: [1-9]/);
    expect(result.toolTelemetry.exitCode).toBeGreaterThan(0);
  });

  it.skipIf(IS_WINDOWS)('captures stderr from a failing command', async () => {
    const tool = getBashTool();
    const result = await tool.handler(
      { command: 'ls /this-path-definitely-does-not-exist-xyz123' },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('failure');
    expect(result.textResultForLlm).toContain('STDERR');
  });

  it('times out and returns failure after timeout_ms', async () => {
    const tool = getBashTool();
    const cmd = IS_WINDOWS ? 'ping -n 10 127.0.0.1 > NUL' : 'sleep 10';
    const result = await tool.handler(
      { command: cmd, timeout_ms: 200 },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('failure');
    expect(result.error).toBe('timeout');
  }, 5000);

  it('truncates output exceeding maxOutputBytes', async () => {
    const tools = createWorkstationTools({ maxOutputBytes: 50 });
    const tool = tools.find(t => t.name === 'workstation_bash')!;
    // Generate output larger than 50 bytes
    const cmd = IS_WINDOWS
      ? 'echo 0123456789012345678901234567890123456789012345678901234567890123456789'
      : 'printf "%0.s0123456789" {1..10}';
    const result = await tool.handler({ command: cmd }, invocationCtx) as any;

    expect(result.textResultForLlm).toContain('truncated');
  });

  it('respects the cwd argument', async () => {
    const tool = getBashTool();
    const cmd = IS_WINDOWS ? 'cd' : 'pwd';
    const result = await tool.handler({ command: cmd, cwd: tmpDir }, invocationCtx) as any;

    expect(result.resultType).toBe('success');
    // The output should contain part of the tmpDir path
    const normalizedTmp = tmpDir.replace(/\\/g, '/').toLowerCase();
    const normalizedOutput = result.textResultForLlm.replace(/\\/g, '/').toLowerCase();
    expect(normalizedOutput).toContain(normalizedTmp.split('/').at(-1));
  });

  it('returns failure for an empty command', async () => {
    const tool = getBashTool();
    const result = await tool.handler({ command: '' }, invocationCtx) as any;

    expect(result.resultType).toBe('failure');
    expect(result.error).toBe('Empty command');
  });
});

// ---------------------------------------------------------------------------
// workstation_read_file
// ---------------------------------------------------------------------------

describe('workstation_read_file', () => {
  function getReadTool() {
    const tools = createWorkstationTools();
    return tools.find(t => t.name === 'workstation_read_file')!;
  }

  it('reads a file and returns its contents', async () => {
    const filePath = join(tmpDir, 'hello.txt');
    await writeFile(filePath, 'Hello, world!', 'utf-8');

    const tool = getReadTool();
    const result = await tool.handler({ path: filePath }, invocationCtx) as any;

    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('Hello, world!');
    expect(result.toolTelemetry.path).toBe(filePath);
  });

  it('returns only the requested line range', async () => {
    const filePath = join(tmpDir, 'lines.txt');
    await writeFile(filePath, 'line1\nline2\nline3\nline4\nline5', 'utf-8');

    const tool = getReadTool();
    const result = await tool.handler(
      { path: filePath, start_line: 2, end_line: 4 },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('line2');
    expect(result.textResultForLlm).toContain('line3');
    expect(result.textResultForLlm).toContain('line4');
    expect(result.textResultForLlm).not.toContain('line1');
    expect(result.textResultForLlm).not.toContain('line5');
    expect(result.toolTelemetry.returnedLines).toBe(3);
  });

  it('returns failure with ENOENT when file does not exist', async () => {
    const tool = getReadTool();
    const result = await tool.handler(
      { path: join(tmpDir, 'nonexistent.txt') },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('failure');
    expect(result.error).toBe('ENOENT');
    expect(result.textResultForLlm).toContain('not found');
  });

  it('truncates files larger than maxOutputBytes', async () => {
    const tools = createWorkstationTools({ maxOutputBytes: 10 });
    const tool = tools.find(t => t.name === 'workstation_read_file')!;

    const filePath = join(tmpDir, 'big.txt');
    await writeFile(filePath, 'A'.repeat(200), 'utf-8');

    const result = await tool.handler({ path: filePath }, invocationCtx) as any;

    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('truncated');
  });
});

// ---------------------------------------------------------------------------
// workstation_write_file
// ---------------------------------------------------------------------------

describe('workstation_write_file', () => {
  function getWriteTool() {
    const tools = createWorkstationTools();
    return tools.find(t => t.name === 'workstation_write_file')!;
  }

  it('writes a new file', async () => {
    const filePath = join(tmpDir, 'output.txt');
    const tool = getWriteTool();

    const result = await tool.handler(
      { path: filePath, content: 'written content' },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('success');
    expect(result.toolTelemetry.path).toBe(filePath);

    // Verify via read
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('written content');
  });

  it('overwrites an existing file', async () => {
    const filePath = join(tmpDir, 'existing.txt');
    await writeFile(filePath, 'old content', 'utf-8');

    const tool = getWriteTool();
    const result = await tool.handler(
      { path: filePath, content: 'new content' },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('success');
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('new content');
  });

  it('creates parent directories when create_dirs is true (default)', async () => {
    const filePath = join(tmpDir, 'nested', 'deep', 'file.txt');
    const tool = getWriteTool();

    const result = await tool.handler(
      { path: filePath, content: 'deep file' },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('success');
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('deep file');
  });

  it('returns failure when create_dirs is false and parent dir missing', async () => {
    const filePath = join(tmpDir, 'missing-dir', 'file.txt');
    const tool = getWriteTool();

    const result = await tool.handler(
      { path: filePath, content: 'content', create_dirs: false },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('failure');
    expect(result.error).toBe('ENOENT');
  });
});

// ---------------------------------------------------------------------------
// workstation_list_dir
// ---------------------------------------------------------------------------

describe('workstation_list_dir', () => {
  function getListTool() {
    const tools = createWorkstationTools();
    return tools.find(t => t.name === 'workstation_list_dir')!;
  }

  beforeEach(async () => {
    await writeFile(join(tmpDir, 'file1.txt'), 'a', 'utf-8');
    await writeFile(join(tmpDir, 'file2.txt'), 'bb', 'utf-8');
    await writeFile(join(tmpDir, '.hidden'), 'secret', 'utf-8');
    await mkdir(join(tmpDir, 'subdir'), { recursive: true });
    await writeFile(join(tmpDir, 'subdir', 'nested.txt'), 'nested', 'utf-8');
  });

  it('lists entries in a directory', async () => {
    const tool = getListTool();
    const result = await tool.handler({ path: tmpDir }, invocationCtx) as any;

    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('file1.txt');
    expect(result.textResultForLlm).toContain('file2.txt');
    expect(result.textResultForLlm).toContain('subdir');
  });

  it('filters hidden files by default', async () => {
    const tool = getListTool();
    const result = await tool.handler({ path: tmpDir }, invocationCtx) as any;

    expect(result.textResultForLlm).not.toContain('.hidden');
  });

  it('includes hidden files when include_hidden is true', async () => {
    const tool = getListTool();
    const result = await tool.handler(
      { path: tmpDir, include_hidden: true },
      invocationCtx,
    ) as any;

    expect(result.textResultForLlm).toContain('.hidden');
  });

  it('returns failure for a non-existent directory', async () => {
    const tool = getListTool();
    const result = await tool.handler(
      { path: join(tmpDir, 'nonexistent') },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('failure');
    expect(result.error).toBe('ENOENT');
  });

  it('recursively lists when recursive is true', async () => {
    const tool = getListTool();
    const result = await tool.handler(
      { path: tmpDir, recursive: true },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('nested.txt');
  });
});

// ---------------------------------------------------------------------------
// workstation_find_files
// ---------------------------------------------------------------------------

describe('workstation_find_files', () => {
  function getFindTool() {
    const tools = createWorkstationTools();
    return tools.find(t => t.name === 'workstation_find_files')!;
  }

  beforeEach(async () => {
    await writeFile(join(tmpDir, 'alpha.ts'), '', 'utf-8');
    await writeFile(join(tmpDir, 'beta.ts'), '', 'utf-8');
    await writeFile(join(tmpDir, 'gamma.json'), '', 'utf-8');
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'index.ts'), '', 'utf-8');
    await writeFile(join(tmpDir, 'src', 'util.ts'), '', 'utf-8');
  });

  it('finds files matching a glob pattern', async () => {
    const tool = getFindTool();
    const result = await tool.handler(
      { pattern: '*.ts', cwd: tmpDir },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('alpha.ts');
    expect(result.textResultForLlm).toContain('beta.ts');
    expect(result.textResultForLlm).not.toContain('gamma.json');
  });

  it('finds files recursively with ** pattern', async () => {
    const tool = getFindTool();
    const result = await tool.handler(
      { pattern: '**/*.ts', cwd: tmpDir },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('alpha.ts');
    expect(result.textResultForLlm).toContain('index.ts');
    expect(result.textResultForLlm).toContain('util.ts');
    expect(result.toolTelemetry.matchCount).toBeGreaterThanOrEqual(4);
  });

  it('returns empty list when no matches', async () => {
    const tool = getFindTool();
    const result = await tool.handler(
      { pattern: '*.py', cwd: tmpDir },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('no matches');
    expect(result.toolTelemetry.matchCount).toBe(0);
  });

  it('respects the cwd argument', async () => {
    const tool = getFindTool();
    const result = await tool.handler(
      { pattern: '*.ts', cwd: join(tmpDir, 'src') },
      invocationCtx,
    ) as any;

    expect(result.resultType).toBe('success');
    expect(result.textResultForLlm).toContain('index.ts');
    expect(result.textResultForLlm).toContain('util.ts');
    // Should NOT contain root-level files since cwd is src/
    expect(result.textResultForLlm).not.toContain('alpha.ts');
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry — workstation integration
// ---------------------------------------------------------------------------

describe('ToolRegistry — workstation integration', () => {
  const WORKSTATION_NAMES = [
    'workstation_bash',
    'workstation_read_file',
    'workstation_write_file',
    'workstation_list_dir',
    'workstation_find_files',
  ];

  it('does NOT register workstation tools by default', () => {
    const registry = new ToolRegistry('.test-squad');
    const names = registry.getTools().map(t => t.name);

    for (const name of WORKSTATION_NAMES) {
      expect(names).not.toContain(name);
    }
  });

  it('registers all 5 workstation tools when enableWorkstationTools: true', () => {
    const registry = new ToolRegistry(
      '.test-squad',
      undefined,
      undefined,
      undefined,
      undefined,
      { enableWorkstationTools: true },
    );
    const names = registry.getTools().map(t => t.name);

    for (const name of WORKSTATION_NAMES) {
      expect(names).toContain(name);
    }
    expect(registry.getTool('workstation_bash')).toBeDefined();
  });

  it('forwards workstationOptions (bashTimeoutMs) into the registered tools', async () => {
    const registry = new ToolRegistry(
      '.test-squad',
      undefined,
      undefined,
      undefined,
      undefined,
      { enableWorkstationTools: true, workstationOptions: { bashTimeoutMs: 100 } },
    );
    const tool = registry.getTool('workstation_bash')!;

    // A command that sleeps 5s should time out well before the default 30s
    const cmd = IS_WINDOWS ? 'ping -n 10 127.0.0.1 > NUL' : 'sleep 5';
    const result = await tool.handler({ command: cmd }, invocationCtx) as any;

    expect(result.resultType).toBe('failure');
    expect(result.error).toBe('timeout');
  }, 5000);
});
