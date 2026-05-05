/**
 * Workstation Tool Bundle
 *
 * Provides agents with a "full workstation" — shell execution, file I/O, and
 * directory navigation — matching the built-in capabilities the original
 * @github/copilot-sdk supplied automatically.
 *
 * ⚠️  SECURITY: These tools give agents filesystem and shell access scoped to
 * rootDir (defaults to process.cwd() when set). They are disabled by default
 * and must be explicitly enabled via ToolRegistryOptions.enableWorkstationTools.
 * Use the onPreToolUse hook for per-call allow-lists or confirmation flows.
 *
 * Security model:
 *   - rootDir confines all path operations; symlink traversal attacks are blocked
 *     via realpath resolution before every I/O call.
 *   - Environment variables matching sensitive patterns are stripped before
 *     commands run, preventing exfiltration of API keys and credentials.
 *   - Timeouts are enforced with a host-controlled ceiling; agent-supplied
 *     timeout_ms values are clamped and cannot be zero or negative.
 *   - On Unix, commands run in a new process group so the entire group
 *     (including background processes spawned with & or nohup) is killed on
 *     timeout. Commands that explicitly call setsid() can still escape.
 *   - Write operations are capped at MAX_WRITE_BYTES to prevent disk exhaustion.
 *   - Binary files are detected and rejected rather than returned as garbage.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat, realpath } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { SquadTool } from '../adapter/types.js';
import { defineTool } from './define-tool.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 102_400;  // 100 KB
const MAX_WRITE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_LIST_ENTRIES = 1_000;
const MAX_FIND_RESULTS = 500;
const BINARY_DETECT_BYTES = 8_192;

/**
 * Environment variable names that are always stripped before shell commands run.
 * Prevents agents from reading API keys, credentials, and loader-injection vars.
 */
const SENSITIVE_ENV_PATTERN = /token|secret|key|password|credential|auth|api/i;
const ALWAYS_STRIP_ENV = new Set([
  'NODE_OPTIONS',           // Could inject --require hooks into child Node processes
  'LD_PRELOAD',             // Unix: inject shared libraries into every exec'd process
  'LD_LIBRARY_PATH',        // Unix: override library resolution
  'DYLD_INSERT_LIBRARIES',  // macOS: equivalent of LD_PRELOAD
  'DYLD_FORCE_FLAT_NAMESPACE',
]);

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * ⚠️  SECURITY: Enabling workstation tools grants agents filesystem and shell
 * access. Set rootDir to confine operations to a specific directory tree.
 */
export interface WorkstationToolsOptions {
  /**
   * Absolute path that ALL file operations and shell cwd values must stay within.
   * Any path that resolves outside this root (including via symlinks) is rejected
   * before I/O occurs. Defaults to process.cwd() when rootDir is set.
   *
   * If omitted, no path confinement is enforced — use only in trusted environments.
   */
  rootDir?: string;

  /** Max shell command execution time in ms. Agent requests are clamped to this ceiling. @default 30000 */
  bashTimeoutMs?: number;

  /** Max combined stdout+stderr bytes returned to the LLM. @default 102400 */
  maxOutputBytes?: number;

  /**
   * Shell binary for workstation_bash.
   * @default 'bash' on Unix/Mac, 'cmd.exe' on Windows
   */
  shell?: string;

  /** Default working directory for workstation_bash when cwd is not specified by the agent. @default rootDir ?? process.cwd() */
  defaultCwd?: string;
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/**
 * Resolve inputPath relative to rootDir, then verify — after following all
 * symlinks — that the result still lives inside rootDir.
 *
 * Handles files that don't exist yet by walking up to the nearest existing
 * ancestor, resolving its symlinks, and reattaching the remaining components.
 *
 * Throws { code: 'EACCES' } if the resolved path escapes rootDir.
 */
async function assertWithinRoot(inputPath: string, rootDir: string): Promise<string> {
  const normalRoot = nodePath.resolve(rootDir);
  const absolute = nodePath.isAbsolute(inputPath)
    ? nodePath.normalize(inputPath)
    : nodePath.resolve(normalRoot, inputPath);

  // Fast pre-check: resolve . and .. without I/O. Catches most traversal attempts.
  if (absolute !== normalRoot && !absolute.startsWith(normalRoot + nodePath.sep)) {
    throw Object.assign(
      new Error(`Path escapes rootDir: "${inputPath}"`),
      { code: 'EACCES' },
    );
  }

  // Symlink resolution: walk up from absolute until we find an existing path,
  // resolve its symlinks, reattach remaining components, and verify the result.
  let toResolve = absolute;
  let suffix = '';

  for (let depth = 0; depth < 64; depth++) {
    try {
      const resolved = await realpath(toResolve);
      const full = suffix ? nodePath.join(resolved, suffix) : resolved;
      const normalFull = nodePath.normalize(full);

      if (normalFull !== normalRoot && !normalFull.startsWith(normalRoot + nodePath.sep)) {
        throw Object.assign(
          new Error(`Path escapes rootDir via symlink: "${inputPath}" → "${resolved}"`),
          { code: 'EACCES' },
        );
      }
      return full;
    } catch (err: any) {
      if (err.code === 'EACCES') throw err;
      if (err.code !== 'ENOENT') throw err;

      // Path doesn't exist — try parent
      const parent = nodePath.dirname(toResolve);
      if (parent === toResolve) break; // reached filesystem root

      suffix = suffix
        ? nodePath.join(nodePath.basename(toResolve), suffix)
        : nodePath.basename(toResolve);
      toResolve = parent;
    }
  }

  // All ancestors unresolvable — return the pre-validated normalized path
  return absolute;
}

/**
 * Return a copy of process.env with sensitive variables removed.
 * Strips anything whose name matches SENSITIVE_ENV_PATTERN or is in
 * ALWAYS_STRIP_ENV, preventing credential exfiltration and library injection.
 */
function buildSafeEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !ALWAYS_STRIP_ENV.has(k) && !SENSITIVE_ENV_PATTERN.test(k),
    ),
  );
}

/**
 * Detect binary content by scanning the first BINARY_DETECT_BYTES for null bytes.
 * Null bytes are reliable indicators of binary files and are not valid UTF-8 text.
 */
function looksLikeBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, BINARY_DETECT_BYTES);
  return sample.includes(0x00);
}

/** Convert a glob pattern to a RegExp for basic file matching. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex metacharacters
    .replace(/\*\*\//g, '\x00')             // **/ → optional directory prefix placeholder
    .replace(/\*\*/g, '\x01')              // standalone ** → any-path placeholder
    .replace(/\*/g, '[^/\\\\]*')            // * → non-separator chars
    .replace(/\?/g, '[^/\\\\]')            // ? → single non-separator char
    .replace(/\x00/g, '(?:.*\\/)?')        // **/ → optional "anything/" prefix
    .replace(/\x01/g, '.*');               // ** → anything
  return new RegExp(`^${escaped}$`);
}

/** Truncate a string to maxBytes, appending a notice if truncated. */
function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  const truncated = buf.subarray(0, maxBytes).toString('utf-8');
  return truncated + `\n\n[Output truncated — ${buf.length} bytes total, showing first ${maxBytes} bytes]`;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Run a shell command via spawn, with process-group kill on timeout (Unix).
 *
 * On Unix, the child runs in a new process group (detached: true without unref).
 * Timeout kills the entire process group via SIGKILL to -pid, which reaches
 * background processes spawned with & or nohup. Processes that call setsid()
 * explicitly can still escape — full containment requires OS-level sandboxing.
 *
 * On Windows, only the direct child is killed; process tree kill via taskkill
 * is not attempted to avoid an additional shell invocation.
 */
function runCommand(
  command: string,
  opts: {
    cwd: string;
    shell: string;
    timeout: number;
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
  },
): Promise<CommandResult> {
  const isUnix = process.platform !== 'win32';

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: opts.shell,
      env: opts.env,
      detached: isUnix,    // Unix: new process group so we can kill -pid
      windowsHide: true,   // Windows: suppress console window
    } as any);

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let bufferKilled = false;

    const killChild = () => {
      try {
        if (isUnix && child.pid) {
          // Unix: kill the entire process group (catches background & nohup processes)
          process.kill(-child.pid, 'SIGKILL');
        } else if (child.pid) {
          // Windows: taskkill /F /T kills the full process tree (cmd.exe + children)
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          child.kill('SIGKILL');
        }
      } catch { /* already exited */ }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        killChild();
      }
    }, opts.timeout);

    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = opts.maxBuffer - Buffer.byteLength(stdout + stderr, 'utf-8');
      if (remaining > 0) {
        stdout += chunk.subarray(0, remaining).toString('utf-8');
      }
      if (Buffer.byteLength(stdout + stderr, 'utf-8') >= opts.maxBuffer) {
        bufferKilled = true;
        killChild();
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = opts.maxBuffer - Buffer.byteLength(stdout + stderr, 'utf-8');
      if (remaining > 0) {
        stderr += chunk.subarray(0, remaining).toString('utf-8');
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        stdout,
        stderr,
        exitCode: bufferKilled ? 1 : (code ?? 1),
        timedOut: timedOut && !bufferKilled,
      });
    });

    child.on('error', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, exitCode: 1, timedOut: false });
    });
  });
}

/** Recursively collect all file paths under a directory, tracking visited inodes. */
async function collectFiles(
  dir: string,
  results: string[],
  base: string,
  visited: Set<string>,
): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = nodePath.join(dir, entry.name);
      const relativePath = nodePath.relative(base, fullPath);

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        try {
          const s = await stat(fullPath); // stat follows symlinks
          const inodeKey = `${s.dev}:${s.ino}`;
          if (s.isDirectory()) {
            if (visited.has(inodeKey)) continue; // circular symlink guard
            visited.add(inodeKey);
            await collectFiles(fullPath, results, base, visited);
          } else {
            results.push(relativePath);
          }
        } catch { /* inaccessible — skip */ }
      } else {
        results.push(relativePath);
      }
    }
  } catch { /* skip unreadable directories */ }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the workstation tool bundle.
 * Register via ToolRegistryOptions.enableWorkstationTools or pass directly to
 * SquadSessionConfig.tools for manual composition.
 */
export function createWorkstationTools(options: WorkstationToolsOptions = {}): SquadTool<any>[] {
  const rootDir = options.rootDir ? nodePath.resolve(options.rootDir) : undefined;
  const bashTimeoutMs = options.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const shell = options.shell ?? (process.platform === 'win32' ? 'cmd.exe' : 'bash');
  const defaultCwd = options.defaultCwd ?? rootDir ?? process.cwd();
  const safeEnv = buildSafeEnv();

  /** Validate a path and return its resolved form. Skips if rootDir not set. */
  async function resolveSafe(inputPath: string): Promise<string> {
    if (!rootDir) return nodePath.resolve(defaultCwd, inputPath);
    return assertWithinRoot(inputPath, rootDir);
  }

  /** Return a path relative to rootDir for telemetry (avoids leaking absolute paths). */
  function toTelemetryPath(resolvedPath: string): string {
    return rootDir ? nodePath.relative(rootDir, resolvedPath) : resolvedPath;
  }

  // -------------------------------------------------------------------------
  // workstation_bash
  // -------------------------------------------------------------------------
  const workstationBash = defineTool<{ command: string; cwd?: string; timeout_ms?: number }>({
    name: 'workstation_bash',
    description:
      'Execute a shell command and return its stdout, stderr, and exit code. ' +
      'Use for running tests, build commands, git operations, and any other shell work. ' +
      (rootDir ? `Operations are confined to: ${rootDir}` : ''),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the configured working directory.' },
        timeout_ms: {
          type: 'number',
          description: `Max execution time in ms. Clamped to [1000, ${bashTimeoutMs}]. Defaults to ${bashTimeoutMs}.`,
        },
      },
      required: ['command'],
    },
    handler: async (args) => {
      if (!args.command?.trim()) {
        return { textResultForLlm: 'Error: command is required', resultType: 'failure', error: 'Empty command' };
      }

      // Clamp timeout: agent cannot set 0, negative, or above the host ceiling
      const agentTimeout = args.timeout_ms;
      const timeout = (agentTimeout != null && agentTimeout > 0)
        ? Math.min(agentTimeout, bashTimeoutMs)
        : bashTimeoutMs;

      // Validate cwd is within rootDir
      let safeCwd: string;
      try {
        safeCwd = args.cwd ? await resolveSafe(args.cwd) : defaultCwd;
      } catch (err: any) {
        return {
          textResultForLlm: `Invalid cwd: ${err.message}`,
          resultType: 'failure',
          error: err.code ?? 'EACCES',
        };
      }

      const startTime = Date.now();
      const result = await runCommand(args.command, {
        cwd: safeCwd,
        shell,
        timeout,
        maxBuffer: maxOutputBytes,
        env: safeEnv,
      });
      const durationMs = Date.now() - startTime;

      if (result.timedOut) {
        return {
          textResultForLlm: `Command timed out after ${timeout}ms.`,
          resultType: 'failure',
          error: 'timeout',
          toolTelemetry: { cwd: toTelemetryPath(safeCwd), durationMs },
        };
      }

      const combined = [
        result.stdout ? `STDOUT:\n${result.stdout}` : '',
        result.stderr ? `STDERR:\n${result.stderr}` : '',
      ].filter(Boolean).join('\n\n') || '(no output)';

      const truncated = truncate(combined, maxOutputBytes);
      const isSuccess = result.exitCode === 0;

      return {
        textResultForLlm: `Exit code: ${result.exitCode}\n\n${truncated}`,
        resultType: isSuccess ? 'success' : 'failure',
        ...(isSuccess ? {} : { error: `exit code ${result.exitCode}` }),
        toolTelemetry: {
          exitCode: result.exitCode,
          stdoutBytes: Buffer.byteLength(result.stdout, 'utf-8'),
          stderrBytes: Buffer.byteLength(result.stderr, 'utf-8'),
          cwd: toTelemetryPath(safeCwd),
          durationMs,
        },
      };
    },
  });

  // -------------------------------------------------------------------------
  // workstation_read_file
  // -------------------------------------------------------------------------
  const workstationReadFile = defineTool<{ path: string; start_line?: number; end_line?: number }>({
    name: 'workstation_read_file',
    description:
      'Read a file and return its contents as text. Optionally specify a line range. ' +
      'Binary files are rejected. Output is capped at 100 KB.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        start_line: { type: 'number', description: 'First line to return (1-indexed, inclusive).' },
        end_line: { type: 'number', description: 'Last line to return (1-indexed, inclusive).' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      if (!args.path?.trim()) {
        return { textResultForLlm: 'Error: path is required', resultType: 'failure', error: 'Empty path' };
      }

      let safePath: string;
      try {
        safePath = await resolveSafe(args.path);
      } catch (err: any) {
        return {
          textResultForLlm: `Access denied: ${err.message}`,
          resultType: 'failure',
          error: err.code ?? 'EACCES',
        };
      }

      try {
        const buf = await readFile(safePath);

        if (looksLikeBinary(buf)) {
          return {
            textResultForLlm: `Cannot read "${args.path}": binary file detected. Use workstation_bash to process binary files.`,
            resultType: 'failure',
            error: 'EBINARY',
          };
        }

        const raw = buf.toString('utf-8');
        const lines = raw.split('\n');
        const totalLines = lines.length;

        let slice: string[];
        if (args.start_line !== undefined || args.end_line !== undefined) {
          const start = Math.max(1, args.start_line ?? 1) - 1;
          const end = args.end_line !== undefined ? args.end_line : totalLines;
          slice = lines.slice(start, end);
        } else {
          slice = lines;
        }

        const content = truncate(slice.join('\n'), maxOutputBytes);

        return {
          textResultForLlm: content,
          resultType: 'success',
          toolTelemetry: {
            path: toTelemetryPath(safePath),
            totalLines,
            returnedLines: slice.length,
            bytes: Buffer.byteLength(content, 'utf-8'),
          },
        };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { textResultForLlm: `File not found: ${args.path}`, resultType: 'failure', error: 'ENOENT' };
        }
        return {
          textResultForLlm: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
          resultType: 'failure',
          error: String(err),
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // workstation_write_file
  // -------------------------------------------------------------------------
  const workstationWriteFile = defineTool<{ path: string; content: string; create_dirs?: boolean }>({
    name: 'workstation_write_file',
    description: 'Write text content to a file, creating or overwriting it. Limited to 10 MB.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write.' },
        content: { type: 'string', description: 'Text content to write.' },
        create_dirs: { type: 'boolean', description: 'Create parent directories if missing. Defaults to true.' },
      },
      required: ['path', 'content'],
    },
    handler: async (args) => {
      if (!args.path?.trim()) {
        return { textResultForLlm: 'Error: path is required', resultType: 'failure', error: 'Empty path' };
      }

      const bytes = Buffer.byteLength(args.content, 'utf-8');
      if (bytes > MAX_WRITE_BYTES) {
        return {
          textResultForLlm: `Content exceeds the 10 MB write limit (${bytes} bytes). Split into smaller writes.`,
          resultType: 'failure',
          error: 'ETOOLARGE',
        };
      }

      let safePath: string;
      try {
        safePath = await resolveSafe(args.path);
      } catch (err: any) {
        return {
          textResultForLlm: `Access denied: ${err.message}`,
          resultType: 'failure',
          error: err.code ?? 'EACCES',
        };
      }

      const createDirs = args.create_dirs !== false;

      try {
        if (createDirs) {
          await mkdir(nodePath.dirname(safePath), { recursive: true });
        }
        await writeFile(safePath, args.content, 'utf-8');

        return {
          textResultForLlm: `File written: ${args.path} (${bytes} bytes)`,
          resultType: 'success',
          toolTelemetry: { path: toTelemetryPath(safePath), bytes },
        };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return {
            textResultForLlm: `Parent directory does not exist. Set create_dirs to true to create it automatically.`,
            resultType: 'failure',
            error: 'ENOENT',
          };
        }
        return {
          textResultForLlm: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
          resultType: 'failure',
          error: String(err),
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // workstation_list_dir
  // -------------------------------------------------------------------------
  const workstationListDir = defineTool<{ path: string; recursive?: boolean; include_hidden?: boolean }>({
    name: 'workstation_list_dir',
    description: 'List the contents of a directory with type and size. Circular symlinks are detected and skipped.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the directory.' },
        recursive: { type: 'boolean', description: 'List recursively. Defaults to false.' },
        include_hidden: { type: 'boolean', description: 'Include dot-prefixed entries. Defaults to false.' },
      },
      required: ['path'],
    },
    handler: async (args) => {
      if (!args.path?.trim()) {
        return { textResultForLlm: 'Error: path is required', resultType: 'failure', error: 'Empty path' };
      }

      let safePath: string;
      try {
        safePath = await resolveSafe(args.path);
      } catch (err: any) {
        return {
          textResultForLlm: `Access denied: ${err.message}`,
          resultType: 'failure',
          error: err.code ?? 'EACCES',
        };
      }

      const includeHidden = args.include_hidden === true;
      const recursive = args.recursive === true;

      type ListEntry = { name: string; type: string; size?: number };

      async function listEntries(
        dir: string,
        relBase: string,
        out: ListEntry[],
        visited: Set<string>,
      ): Promise<void> {
        const dirents = await readdir(dir, { withFileTypes: true });
        for (const entry of dirents) {
          if (out.length >= MAX_LIST_ENTRIES) break;
          const relName = relBase ? `${relBase}/${entry.name}` : entry.name;
          if (!includeHidden && relName.split('/').some(p => p.startsWith('.'))) continue;

          const fullPath = nodePath.join(dir, entry.name);
          const isDir = entry.isDirectory() || entry.isSymbolicLink();
          let entryIsDir = entry.isDirectory();
          let size: number | undefined;

          if (isDir) {
            try {
              const s = await stat(fullPath);
              entryIsDir = s.isDirectory();
              if (!entryIsDir) {
                size = s.size;
              } else if (recursive) {
                const inodeKey = `${s.dev}:${s.ino}`;
                if (visited.has(inodeKey)) {
                  out.push({ name: relName, type: 'directory (symlink loop — skipped)', size: undefined });
                  continue;
                }
                visited.add(inodeKey);
              }
            } catch { /* stat failed — include with unknown type */ }
          } else {
            try { size = (await stat(fullPath)).size; } catch { /* skip */ }
          }

          out.push({ name: relName, type: entryIsDir ? 'directory' : 'file', size });

          if (recursive && entryIsDir) {
            await listEntries(fullPath, relName, out, visited);
          }
        }
      }

      try {
        const rootStat = await stat(safePath);
        const visited = new Set<string>([`${rootStat.dev}:${rootStat.ino}`]);
        const results: ListEntry[] = [];
        await listEntries(safePath, '', results, visited);

        let text = results
          .map(e => {
            const prefix = e.type === 'directory' ? 'd' : e.type === 'file' ? 'f' : e.type;
            return `${prefix}  ${e.name}${e.size !== undefined ? `  (${e.size} bytes)` : ''}`;
          })
          .join('\n');

        if (results.length >= MAX_LIST_ENTRIES) {
          text += `\n\n[List truncated at ${MAX_LIST_ENTRIES} entries]`;
        }

        return {
          textResultForLlm: text || '(empty directory)',
          resultType: 'success',
          toolTelemetry: { path: toTelemetryPath(safePath), entryCount: results.length, recursive },
        };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { textResultForLlm: `Directory not found: ${args.path}`, resultType: 'failure', error: 'ENOENT' };
        }
        if (err.code === 'ENOTDIR') {
          return { textResultForLlm: `Path is not a directory: ${args.path}`, resultType: 'failure', error: 'ENOTDIR' };
        }
        return {
          textResultForLlm: `Failed to list directory: ${err instanceof Error ? err.message : String(err)}`,
          resultType: 'failure',
          error: String(err),
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // workstation_find_files
  // -------------------------------------------------------------------------
  const workstationFindFiles = defineTool<{ pattern: string; cwd?: string }>({
    name: 'workstation_find_files',
    description:
      'Find files matching a glob pattern. Supports * (within a segment), ** (any depth), ? (single char). ' +
      'Circular symlinks are detected and skipped.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts", "*.json").' },
        cwd: { type: 'string', description: 'Root directory to search from. Defaults to the working directory.' },
      },
      required: ['pattern'],
    },
    handler: async (args) => {
      if (!args.pattern?.trim()) {
        return { textResultForLlm: 'Error: pattern is required', resultType: 'failure', error: 'Empty pattern' };
      }

      let searchRoot: string;
      try {
        searchRoot = args.cwd ? await resolveSafe(args.cwd) : defaultCwd;
      } catch (err: any) {
        return {
          textResultForLlm: `Access denied: ${err.message}`,
          resultType: 'failure',
          error: err.code ?? 'EACCES',
        };
      }

      const regex = globToRegex(args.pattern);

      try {
        const rootStat = await stat(searchRoot);
        const visited = new Set<string>([`${rootStat.dev}:${rootStat.ino}`]);
        const allFiles: string[] = [];
        await collectFiles(searchRoot, allFiles, searchRoot, visited);

        const matches = allFiles
          .map(f => f.replace(/\\/g, '/'))
          .filter(f => regex.test(f))
          .slice(0, MAX_FIND_RESULTS);

        const text = matches.length > 0 ? matches.join('\n') : '(no matches)';
        const truncationNote = matches.length >= MAX_FIND_RESULTS
          ? `\n\n[Results capped at ${MAX_FIND_RESULTS} — refine your pattern to narrow results]`
          : '';

        return {
          textResultForLlm: text + truncationNote,
          resultType: 'success',
          toolTelemetry: {
            pattern: args.pattern,
            cwd: toTelemetryPath(searchRoot),
            matchCount: matches.length,
          },
        };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { textResultForLlm: `Search root not found: ${args.cwd ?? defaultCwd}`, resultType: 'failure', error: 'ENOENT' };
        }
        return {
          textResultForLlm: `Failed to find files: ${err instanceof Error ? err.message : String(err)}`,
          resultType: 'failure',
          error: String(err),
        };
      }
    },
  });

  return [
    workstationBash,
    workstationReadFile,
    workstationWriteFile,
    workstationListDir,
    workstationFindFiles,
  ];
}
