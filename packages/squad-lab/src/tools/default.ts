/**
 * The tools a variant's agents get, jailed to the work repo.
 *
 * Deliberately small and identical across vendors: the comparison is only
 * like-for-like if both squads had the same reach. Note that the Anthropic
 * backend additionally ships its own Read/Write/Edit/Bash, scoped by
 * `workingDirectory`, so tool *counts* still are not strictly comparable —
 * which is why the run report separates registered tools from built-ins.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { safePath } from './jail.js';

export interface LabTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: any, ctx?: any) => Promise<{ textResultForLlm: string; resultType: string }>;
}

export function defaultTools(workDir: string): LabTool[] {
  return [
    {
      name: 'write_file',
      description: 'Write a UTF-8 text file in the repository, creating or overwriting it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative path, e.g. src/duration.js' },
          content: { type: 'string', description: 'Full file contents' },
        },
        required: ['path', 'content'],
      },
      handler: async (args: { path: string; content: string }) => {
        writeFileSync(safePath(workDir, args.path), args.content, 'utf8');
        return { textResultForLlm: `wrote ${args.path}`, resultType: 'success' };
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the repository.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      handler: async (args: { path: string }) => {
        const p = safePath(workDir, args.path);
        if (!existsSync(p)) {
          return { textResultForLlm: `no such file: ${args.path}`, resultType: 'failure' };
        }
        return { textResultForLlm: readFileSync(p, 'utf8'), resultType: 'success' };
      },
    },
    {
      name: 'run_node_test',
      description: 'Run a Node.js test file with the built-in test runner and return its output.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Repo-relative test file' } },
        required: ['path'],
      },
      handler: async (args: { path: string }) => {
        // Resolved through the jail so a test path cannot reach out of the repo,
        // then handed back as repo-relative because that is what `node --test`
        // is being run against.
        safePath(workDir, args.path);
        try {
          const out = execFileSync('node', ['--test', args.path], {
            cwd: workDir,
            encoding: 'utf8',
            timeout: 60_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return { textResultForLlm: out.slice(-4000), resultType: 'success' };
        } catch (err: any) {
          const out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.slice(-4000);
          return { textResultForLlm: out || String(err), resultType: 'failure' };
        }
      },
    },
  ];
}

/**
 * Ground truth for tool executions, taken at the handler.
 *
 * Deliberately not taken from the EventBus. If the bus never hears about a tool
 * call then comparing ADP to the bus shows 0 == 0 and calls the row reconciled
 * — a reconciliation whose two sides share a blind spot proves nothing. The
 * handler having run is the one fact that cannot go missing.
 */
export function instrument(tool: LabTool, logPath: string): LabTool {
  const inner = tool.handler;
  return {
    ...tool,
    handler: async (args: any, ctx: any) => {
      const started = Date.now();
      let result: { textResultForLlm: string; resultType: string } | undefined;
      try {
        result = await inner(args, ctx);
        return result;
      } finally {
        appendFileSync(
          logPath,
          `${JSON.stringify({
            tool: tool.name,
            sessionId: ctx?.sessionId,
            resultType: result?.resultType ?? 'error',
            durationMs: Date.now() - started,
            at: new Date().toISOString(),
          })}\n`,
        );
      }
    },
  };
}
