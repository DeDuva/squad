/**
 * Exposes squad's own tools to the Agent SDK as an in-process MCP server.
 *
 * Why MCP and not "just register a function": `createSdkMcpServer` is the
 * SDK's only custom-tool mechanism, and being in-process is what matters —
 * handlers keep their closures over `ToolRegistry`, the team root, and the
 * state backend. A stdio MCP server would need a separate process and all of
 * that re-plumbed across it.
 *
 * Filesystem and shell work is deliberately NOT bridged. The SDK ships
 * Read/Write/Edit/Glob/Grep/Bash already, and squad's `workstation_*` tools
 * are hand-rolled equivalents; offering both gives the model two overlapping
 * toolsets to choose between, which degrades tool selection and burns context
 * for nothing. What squad bridges is what has no SDK equivalent — routing,
 * decisions, memory, state, skills.
 *
 * @module adapter/anthropic/tool-bridge
 */

import { randomUUID } from 'node:crypto';
import { loadAgentSdk } from './agent-sdk.js';
import type { SquadTool, SquadToolResultObject } from '../types.js';

/** Prefix the SDK gives MCP tools when matching against `allowedTools`. */
export const MCP_SERVER_NAME = 'squad';

/**
 * squad tools that duplicate an SDK built-in and are therefore not bridged.
 *
 * `buildAgentTools` hands over the whole registry, which includes squad's
 * hand-rolled filesystem and shell tools. A worker session is already granted
 * the SDK's native Read/Write/Edit/Glob/Grep/Bash, so bridging these too
 * would put two tools for the same job in front of the model — the classic
 * way to make tool selection worse. The Gemini backend still needs them,
 * which is why they are filtered here rather than removed from the registry.
 */
const DUPLICATES_SDK_BUILTIN = /^workstation_/;

/** Whether a squad tool should be exposed to the Agent SDK. */
export function shouldBridge(toolName: string): boolean {
  return !DUPLICATES_SDK_BUILTIN.test(toolName);
}

/** The `allowedTools` entry for a bridged tool. */
export function mcpToolName(toolName: string): string {
  return `mcp__${MCP_SERVER_NAME}__${toolName}`;
}

/**
 * Minimal Zod surface used by the converter.
 *
 * Typed structurally rather than importing zod, so squad-sdk keeps zod as an
 * optional peer: a Gemini-only user should not need it installed.
 */
interface ZodLike {
  string(): ZodTypeLike;
  number(): ZodTypeLike;
  boolean(): ZodTypeLike;
  array(inner: ZodTypeLike): ZodTypeLike;
  object(shape: Record<string, ZodTypeLike>): ZodTypeLike;
  enum(values: [string, ...string[]]): ZodTypeLike;
  unknown(): ZodTypeLike;
}

interface ZodTypeLike {
  optional(): ZodTypeLike;
  describe(text: string): ZodTypeLike;
}

/** A JSON Schema node, as far as the converter cares. */
interface JsonSchemaNode {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

/** Normalize `SquadTool.parameters` to plain JSON Schema. */
export function toJsonSchema(parameters: unknown): JsonSchemaNode {
  if (!parameters || typeof parameters !== 'object') return {};
  const maybeZod = parameters as { toJSONSchema?: () => unknown };
  if (typeof maybeZod.toJSONSchema === 'function') {
    const converted = maybeZod.toJSONSchema();
    return (converted && typeof converted === 'object' ? converted : {}) as JsonSchemaNode;
  }
  return parameters as JsonSchemaNode;
}

/** Convert one JSON Schema node to a Zod type. */
function nodeToZod(z: ZodLike, node: JsonSchemaNode): ZodTypeLike {
  let out: ZodTypeLike;

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum.filter((v): v is string => typeof v === 'string');
    // A non-string enum can't be expressed as a Zod enum; fall back to
    // unknown rather than dropping the parameter entirely.
    out = values.length === node.enum.length ? z.enum(values as [string, ...string[]]) : z.unknown();
  } else {
    switch (node.type) {
      case 'string':
        out = z.string();
        break;
      case 'number':
      case 'integer':
        out = z.number();
        break;
      case 'boolean':
        out = z.boolean();
        break;
      case 'array':
        out = z.array(node.items ? nodeToZod(z, node.items) : z.unknown());
        break;
      case 'object':
        out = z.object(shapeFromProperties(z, node));
        break;
      default:
        // Unions, `$ref`, and anything else squad doesn't emit. Accepting it
        // as unknown keeps the tool callable; rejecting would remove a tool
        // from the agent over a schema detail the model never sees.
        out = z.unknown();
    }
  }

  return node.description ? out.describe(node.description) : out;
}

function shapeFromProperties(z: ZodLike, schema: JsonSchemaNode): Record<string, ZodTypeLike> {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodTypeLike> = {};

  for (const [key, node] of Object.entries(properties)) {
    const zodType = nodeToZod(z, node);
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }
  return shape;
}

/**
 * Convert a tool's parameter schema to the Zod raw shape `tool()` requires.
 *
 * Verified: passing raw JSON Schema is rejected at runtime with
 * "inputSchema must be a Zod schema or raw shape", so this conversion is
 * mandatory rather than a convenience.
 */
export function toZodShape(z: ZodLike, parameters: unknown): Record<string, ZodTypeLike> {
  return shapeFromProperties(z, toJsonSchema(parameters));
}

/** Flatten a squad tool result into the text an MCP result carries. */
export function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === null || result === undefined) return '';

  const structured = result as Partial<SquadToolResultObject>;
  if (typeof structured.textResultForLlm === 'string') return structured.textResultForLlm;
  if (typeof structured.error === 'string') return structured.error;

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Wrap squad's tools as an in-process MCP server.
 *
 * @param tools - squad tools to expose
 * @param sessionId - passed to each handler's invocation context
 * @returns the server config to hand to `Options.mcpServers`, plus the
 *   `allowedTools` names the model needs in order to call them
 */
export async function buildSquadMcpServer(
  allTools: SquadTool<never>[],
  sessionId: string,
): Promise<{ server: unknown; toolNames: string[] } | null> {
  const tools = allTools.filter((t) => shouldBridge(t.name));
  if (tools.length === 0) return null;

  const sdk = await loadAgentSdk();
  if (!sdk.tool || !sdk.createSdkMcpServer) {
    throw new Error(
      'The installed @anthropic-ai/claude-agent-sdk does not expose tool()/createSdkMcpServer(); ' +
        'squad tools cannot be bridged. Upgrade the SDK, or run without squad tools.',
    );
  }

  const { z } = (await import('zod')) as unknown as { z: ZodLike };

  const definitions = tools.map((squadTool) =>
    sdk.tool!(
      squadTool.name,
      squadTool.description ?? squadTool.name,
      toZodShape(z, squadTool.parameters),
      async (args: unknown) => {
        try {
          const output = await squadTool.handler(args as never, {
            sessionId,
            toolCallId: randomUUID(),
            toolName: squadTool.name,
            arguments: args,
          });
          return { content: [{ type: 'text', text: stringifyToolResult(output) }] };
        } catch (err) {
          // Surface the failure to the model as a tool result it can react
          // to, rather than letting it escape and abort the whole turn.
          return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    ),
  );

  return {
    server: sdk.createSdkMcpServer({ name: MCP_SERVER_NAME, version: '1', tools: definitions }),
    toolNames: tools.map((t) => mcpToolName(t.name)),
  };
}
