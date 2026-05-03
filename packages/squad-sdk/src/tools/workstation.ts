/**
 * Workstation Tool Bundle
 *
 * Provides agents with a "full workstation" — shell execution, file I/O, and
 * directory navigation — matching the built-in capabilities the original
 * @github/copilot-sdk supplied automatically.
 *
 * ⚠️  SECURITY: These tools give agents full filesystem and shell access within
 * the OS permissions of the host process. They are disabled by default and must
 * be explicitly enabled via ToolRegistryOptions.enableWorkstationTools. Use the
 * onPreToolUse hook to enforce per-call allow-lists or confirmation flows.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { SquadTool } from '../adapter/types.js';
import { defineTool } from './define-tool.js';

const execAsync = promisify(exec);

const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 102_400; // 100 KB
const MAX_LIST_ENTRIES = 1_000;
const MAX_FIND_RESULTS = 500;

/**
 * ⚠️  SECURITY: Enabling workstation tools grants agents full filesystem and
 * shell access. Use the onPreToolUse hook to enforce restrictions.
 */
export interface WorkstationToolsOptions {
  /** Max shell command execution time in ms. @default 30000 */
  bashTimeoutMs?: number;
  /** Max combined stdout+stderr bytes returned to the LLM. @default 102400 */
  maxOutputBytes?: number;
  /**
   * Shell binary for workstation_bash.
   * @default 'bash' on Unix/Mac, 'cmd.exe' on Windows
   */
  shell?: string;
  /** Default working directory for workstation_bash. @default process.cwd() */
  defaultCwd?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a glob pattern to a RegExp for basic file matching. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // escape regex metacharacters
    .replace(/\*\*\//g, '\x00')              // **/ → optional directory prefix placeholder
    .replace(/\*\*/g, '\x01')               // standalone ** → any-path placeholder
    .replace(/\*/g, '[^/\\\\]*')             // * → non-separator chars
    .replace(/\?/g, '[^/\\\\]')             // ? → single non-separator char
    .replace(/\x00/g, '(?:.*\\/)?')         // **/ → optional "anything/" prefix
    .replace(/\x01/g, '.*');                // ** → anything
  return new RegExp(`^${escaped}$`);
}

/** Recursively collect all files under a directory. */
async function collectFiles(dir: string, results: string[], base: string): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = nodePath.join(dir, entry.name);
      const relativePath = nodePath.relative(base, fullPath);
      if (entry.isDirectory()) {
        await collectFiles(fullPath, results, base);
      } else {
        results.push(relativePath);
      }
    }
  } catch {
    // skip unreadable directories
  }
}

/** Truncate a string to maxBytes, appending a notice if truncated. */
function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  const truncated = buf.subarray(0, maxBytes).toString('utf-8');
  return truncated + `\n\n[Output truncated — ${buf.length} bytes total, showing first ${maxBytes} bytes]`;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the workstation tool bundle.
 * Register these tools via ToolRegistryOptions.enableWorkstationTools or pass
 * them directly to SquadSessionConfig.tools.
 */
export function createWorkstationTools(options: WorkstationToolsOptions = {}): SquadTool<any>[] {
  const bashTimeoutMs = options.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const shell = options.shell ?? (process.platform === 'win32' ? 'cmd.exe' : 'bash');
  const defaultCwd = options.defaultCwd ?? process.cwd();

  // -------------------------------------------------------------------------
  // workstation_bash
  // -------------------------------------------------------------------------
  const workstationBash = defineTool<{ command: string; cwd?: string; timeout_ms?: number }>({
    name: 'workstation_bash',
    description:
      'Execute a shell command and return its stdout, stderr, and exit code. ' +
      'Use for running tests, build commands, git operations, and any other shell work.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command. Defaults to the process working directory.',
        },
        timeout_ms: {
          type: 'number',
          description: `Max execution time in milliseconds. Defaults to ${DEFAULT_BASH_TIMEOUT_MS}.`,
        },
      },
      required: ['command'],
    },
    handler: async (args) => {
      if (!args.command?.trim()) {
        return { textResultForLlm: 'Error: command is required', resultType: 'failure', error: 'Empty command' };
      }

      const cwd = args.cwd ?? defaultCwd;
      const timeout = args.timeout_ms ?? bashTimeoutMs;
      const startTime = Date.now();

      try {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd,
          timeout,
          maxBuffer: maxOutputBytes * 2,
          shell,
        });

        const combined = [
          stdout ? `STDOUT:\n${stdout}` : '',
          stderr ? `STDERR:\n${stderr}` : '',
        ].filter(Boolean).join('\n\n') || '(no output)';

        const truncated = truncate(combined, maxOutputBytes);
        const durationMs = Date.now() - startTime;

        return {
          textResultForLlm: `Exit code: 0\n\n${truncated}`,
          resultType: 'success',
          toolTelemetry: {
            exitCode: 0,
            stdoutBytes: Buffer.byteLength(stdout, 'utf-8'),
            stderrBytes: Buffer.byteLength(stderr, 'utf-8'),
            cwd,
            durationMs,
          },
        };
      } catch (err: any) {
        const durationMs = Date.now() - startTime;

        if (err.killed || err.signal === 'SIGTERM' || (err.code === undefined && err.stdout === undefined)) {
          return {
            textResultForLlm: `Command timed out after ${timeout}ms: ${args.command}`,
            resultType: 'failure',
            error: 'timeout',
            toolTelemetry: { cwd, durationMs },
          };
        }

        const exitCode: number = err.code ?? 1;
        const stdout: string = err.stdout ?? '';
        const stderr: string = err.stderr ?? '';
        const combined = [
          stdout ? `STDOUT:\n${stdout}` : '',
          stderr ? `STDERR:\n${stderr}` : '',
        ].filter(Boolean).join('\n\n') || '(no output)';

        const truncated = truncate(combined, maxOutputBytes);

        return {
          textResultForLlm: `Exit code: ${exitCode}\n\n${truncated}`,
          resultType: 'failure',
          error: `exit code ${exitCode}`,
          toolTelemetry: {
            exitCode,
            stdoutBytes: Buffer.byteLength(stdout, 'utf-8'),
            stderrBytes: Buffer.byteLength(stderr, 'utf-8'),
            cwd,
            durationMs,
          },
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // workstation_read_file
  // -------------------------------------------------------------------------
  const workstationReadFile = defineTool<{ path: string; start_line?: number; end_line?: number }>({
    name: 'workstation_read_file',
    description:
      'Read a file from the filesystem and return its contents as text. ' +
      'Optionally specify a line range to read a subset of the file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the file.',
        },
        start_line: {
          type: 'number',
          description: 'First line to return (1-indexed, inclusive). Omit to start from the beginning.',
        },
        end_line: {
          type: 'number',
          description: 'Last line to return (1-indexed, inclusive). Omit to read to the end of the file.',
        },
      },
      required: ['path'],
    },
    handler: async (args) => {
      if (!args.path?.trim()) {
        return { textResultForLlm: 'Error: path is required', resultType: 'failure', error: 'Empty path' };
      }

      try {
        const raw = await readFile(args.path, 'utf-8');
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
            path: args.path,
            totalLines,
            returnedLines: slice.length,
            bytes: Buffer.byteLength(content, 'utf-8'),
          },
        };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return {
            textResultForLlm: `File not found: ${args.path}`,
            resultType: 'failure',
            error: 'ENOENT',
          };
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
    description:
      'Write content to a file, creating or overwriting it. ' +
      'Parent directories are created automatically by default.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'Text content to write to the file.',
        },
        create_dirs: {
          type: 'boolean',
          description: 'Create parent directories if they do not exist. Defaults to true.',
        },
      },
      required: ['path', 'content'],
    },
    handler: async (args) => {
      if (!args.path?.trim()) {
        return { textResultForLlm: 'Error: path is required', resultType: 'failure', error: 'Empty path' };
      }

      const createDirs = args.create_dirs !== false;

      try {
        if (createDirs) {
          const dir = nodePath.dirname(args.path);
          await mkdir(dir, { recursive: true });
        }
        await writeFile(args.path, args.content, 'utf-8');

        const bytes = Buffer.byteLength(args.content, 'utf-8');
        return {
          textResultForLlm: `File written: ${args.path} (${bytes} bytes)`,
          resultType: 'success',
          toolTelemetry: { path: args.path, bytes },
        };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return {
            textResultForLlm: `Parent directory does not exist: ${nodePath.dirname(args.path)}. Set create_dirs to true to create it automatically.`,
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
    description: 'List the contents of a directory. Returns entry names with file/directory type and size.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the directory.',
        },
        recursive: {
          type: 'boolean',
          description: 'List all entries recursively. Defaults to false.',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include entries whose names start with a dot. Defaults to false.',
        },
      },
      required: ['path'],
    },
    handler: async (args) => {
      if (!args.path?.trim()) {
        return { textResultForLlm: 'Error: path is required', resultType: 'failure', error: 'Empty path' };
      }

      const includeHidden = args.include_hidden === true;
      const recursive = args.recursive === true;

      type ListEntry = { name: string; type: string; size?: number };

      async function listEntries(dir: string, relBase: string, out: ListEntry[]): Promise<void> {
        const dirents = await readdir(dir, { withFileTypes: true });
        for (const entry of dirents) {
          if (out.length >= MAX_LIST_ENTRIES) break;
          const relName = relBase ? `${relBase}/${entry.name}` : entry.name;
          if (!includeHidden && relName.split('/').some(p => p.startsWith('.'))) continue;

          const isDir = entry.isDirectory();
          let size: number | undefined;
          if (!isDir) {
            try { size = (await stat(nodePath.join(dir, entry.name))).size; } catch { /* skip */ }
          }
          out.push({ name: relName, type: isDir ? 'directory' : 'file', size });

          if (recursive && isDir) {
            await listEntries(nodePath.join(dir, entry.name), relName, out);
          }
        }
      }

      try {
        const results: ListEntry[] = [];
        await listEntries(args.path, '', results);

        let text = results
          .map(e => `${e.type === 'directory' ? 'd' : 'f'}  ${e.name}${e.size !== undefined ? `  (${e.size} bytes)` : ''}`)
          .join('\n');

        if (results.length >= MAX_LIST_ENTRIES) {
          text += `\n\n[List truncated at ${MAX_LIST_ENTRIES} entries]`;
        }

        return {
          textResultForLlm: text || '(empty directory)',
          resultType: 'success',
          toolTelemetry: { path: args.path, entryCount: results.length, recursive },
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
      'Find files matching a glob pattern within a directory tree. ' +
      'Supports * (any chars within a segment), ** (any path depth), and ? (single char).',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match (e.g. "src/**/*.ts", "*.json").',
        },
        cwd: {
          type: 'string',
          description: 'Root directory to search from. Defaults to the process working directory.',
        },
      },
      required: ['pattern'],
    },
    handler: async (args) => {
      if (!args.pattern?.trim()) {
        return { textResultForLlm: 'Error: pattern is required', resultType: 'failure', error: 'Empty pattern' };
      }

      const searchRoot = args.cwd ?? defaultCwd;
      const regex = globToRegex(args.pattern);

      try {
        const allFiles: string[] = [];
        await collectFiles(searchRoot, allFiles, searchRoot);

        // Normalize separators for matching
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
          toolTelemetry: { pattern: args.pattern, cwd: searchRoot, matchCount: matches.length },
        };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return {
            textResultForLlm: `Search root not found: ${searchRoot}`,
            resultType: 'failure',
            error: 'ENOENT',
          };
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
