/**
 * defineTool — typed tool factory with automatic OTel tracing.
 * Extracted to a separate module so workstation.ts can import it
 * without creating a circular dependency with tools/index.ts.
 */

import type { SquadTool, SquadToolResult } from '../adapter/types.js';
import { trace, SpanStatusCode } from '../runtime/otel-api.js';

const tracer = trace.getTracer('squad-sdk');

/** Sensitive field patterns — strip before recording as span attributes. */
const SENSITIVE_PATTERNS = /^(content|query)$|token|secret|password|key|auth/i;

/**
 * Sanitize tool arguments for OTel span attributes.
 * Strips any field whose name matches sensitive patterns (case-insensitive).
 * Returns JSON string truncated to 1024 chars.
 */
export function sanitizeArgs(args: unknown): string {
  if (args == null || typeof args !== 'object') {
    return JSON.stringify(args ?? null).slice(0, 1024);
  }
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    sanitized[k] = SENSITIVE_PATTERNS.test(k) ? '[REDACTED]' : v;
  }
  return JSON.stringify(sanitized).slice(0, 1024);
}

/**
 * Define a typed Squad tool with JSON schema parameters.
 * Automatically wraps the handler with OTel span creation, event logging,
 * error recording, and duration tracking.
 */
export function defineTool<TArgs = unknown>(config: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: TArgs) => Promise<SquadToolResult> | SquadToolResult;
  agentName?: string;
}): SquadTool<TArgs> {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    handler: async (args: TArgs) => {
      const span = tracer.startSpan('squad.tool.call', {
        attributes: {
          'tool.name': config.name,
          ...(config.agentName ? { 'agent.name': config.agentName } : {}),
          'tool.args': sanitizeArgs(args),
        },
      });
      const startTime = Date.now();
      try {
        const result = await config.handler(args);
        const durationMs = Date.now() - startTime;
        const resultType = typeof result === 'string' ? 'unknown' : (result.resultType ?? 'unknown');
        const resultText = typeof result === 'string' ? result : (result.textResultForLlm ?? '');
        span.addEvent('squad.tool.result', {
          'result.type': resultType,
          'result.length': resultText.length,
          'duration_ms': durationMs,
          'success': resultType !== 'failure',
        });
        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        span.addEvent('squad.tool.error', {
          'error.type': err instanceof Error ? err.constructor.name : 'unknown',
          'error.message': err instanceof Error ? err.message : String(err),
          'duration_ms': durationMs,
        });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        span.end();
      }
    },
  };
}
