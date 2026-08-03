/**
 * Bridging squad's tools onto the Agent SDK.
 *
 * The schema conversion is mandatory, not a convenience: passing raw JSON
 * Schema to the SDK's `tool()` is rejected at runtime with "inputSchema must
 * be a Zod schema or raw shape".
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  toJsonSchema,
  toZodShape,
  stringifyToolResult,
  mcpToolName,
  shouldBridge,
} from '../packages/squad-sdk/src/adapter/anthropic/tool-bridge.js';

/** Round-trip a converted shape through Zod to check it validates as intended. */
function parseWith(shape: Record<string, unknown>, value: unknown) {
  return z.object(shape as never).safeParse(value);
}

describe('toJsonSchema', () => {
  it('passes a plain JSON Schema through', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };

    expect(toJsonSchema(schema)).toEqual(schema);
  });

  it('calls toJSONSchema() on a Zod-like schema', () => {
    const zodLike = { toJSONSchema: () => ({ type: 'object', properties: { b: { type: 'number' } } }) };

    expect(toJsonSchema(zodLike)).toEqual({ type: 'object', properties: { b: { type: 'number' } } });
  });

  it('treats missing parameters as an empty schema', () => {
    expect(toJsonSchema(undefined)).toEqual({});
    expect(toJsonSchema(null)).toEqual({});
  });
});

describe('toZodShape', () => {
  it('converts primitives', () => {
    const shape = toZodShape(z as never, {
      type: 'object',
      properties: { s: { type: 'string' }, n: { type: 'number' }, b: { type: 'boolean' } },
      required: ['s', 'n', 'b'],
    });

    expect(parseWith(shape, { s: 'x', n: 1, b: true }).success).toBe(true);
    expect(parseWith(shape, { s: 1, n: 1, b: true }).success).toBe(false);
  });

  it('maps integer onto number', () => {
    const shape = toZodShape(z as never, {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    });

    expect(parseWith(shape, { count: 3 }).success).toBe(true);
  });

  it('makes non-required properties optional', () => {
    const shape = toZodShape(z as never, {
      type: 'object',
      properties: { needed: { type: 'string' }, extra: { type: 'string' } },
      required: ['needed'],
    });

    expect(parseWith(shape, { needed: 'x' }).success).toBe(true);
    expect(parseWith(shape, { extra: 'x' }).success).toBe(false);
  });

  it('converts enums', () => {
    const shape = toZodShape(z as never, {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast', 'slow'] } },
      required: ['mode'],
    });

    expect(parseWith(shape, { mode: 'fast' }).success).toBe(true);
    expect(parseWith(shape, { mode: 'sideways' }).success).toBe(false);
  });

  it('converts arrays including their item type', () => {
    const shape = toZodShape(z as never, {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
    });

    expect(parseWith(shape, { tags: ['a', 'b'] }).success).toBe(true);
    expect(parseWith(shape, { tags: [1] }).success).toBe(false);
  });

  it('converts nested objects', () => {
    const shape = toZodShape(z as never, {
      type: 'object',
      properties: {
        opts: {
          type: 'object',
          properties: { deep: { type: 'string' } },
          required: ['deep'],
        },
      },
      required: ['opts'],
    });

    expect(parseWith(shape, { opts: { deep: 'x' } }).success).toBe(true);
    expect(parseWith(shape, { opts: {} }).success).toBe(false);
  });

  it('accepts an unsupported node as unknown rather than dropping the tool', () => {
    // Losing one parameter's precision is far better than removing a whole
    // tool from the agent because of a schema construct squad doesn't emit.
    const shape = toZodShape(z as never, {
      type: 'object',
      properties: { weird: { anyOf: [{ type: 'string' }, { type: 'number' }] } as never },
      required: ['weird'],
    });

    expect(parseWith(shape, { weird: 'either' }).success).toBe(true);
    expect(parseWith(shape, { weird: 42 }).success).toBe(true);
  });

  it('produces an empty shape for a schema with no properties', () => {
    expect(toZodShape(z as never, {})).toEqual({});
  });
});

describe('stringifyToolResult', () => {
  it('passes strings through', () => {
    expect(stringifyToolResult('done')).toBe('done');
  });

  it('prefers the LLM-facing text of a structured result', () => {
    expect(stringifyToolResult({ textResultForLlm: 'for the model', resultType: 'text' })).toBe('for the model');
  });

  it('falls back to the error message', () => {
    expect(stringifyToolResult({ error: 'it broke' })).toBe('it broke');
  });

  it('serializes anything else', () => {
    expect(stringifyToolResult({ a: 1 })).toBe('{"a":1}');
  });

  it('renders nullish as empty rather than the string "undefined"', () => {
    expect(stringifyToolResult(undefined)).toBe('');
    expect(stringifyToolResult(null)).toBe('');
  });

  it('does not throw on a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => stringifyToolResult(circular)).not.toThrow();
  });
});

describe('mcpToolName', () => {
  it('uses the prefix the SDK matches allowedTools against', () => {
    expect(mcpToolName('squad_route')).toBe('mcp__squad__squad_route');
  });
});

describe('shouldBridge', () => {
  it('bridges squad tools that have no SDK equivalent', () => {
    for (const name of ['squad_route', 'squad_decide', 'squad_memory', 'squad_state_read', 'squad_skill']) {
      expect(shouldBridge(name)).toBe(true);
    }
  });

  it('does not bridge tools that duplicate an SDK built-in', () => {
    // A worker already has native Read/Write/Edit/Glob/Grep/Bash. Bridging
    // squad's hand-rolled equivalents would put two tools for the same job in
    // front of the model, which is how tool selection gets worse.
    for (const name of ['workstation_bash', 'workstation_read_file', 'workstation_write_file',
                        'workstation_list_dir', 'workstation_find_files']) {
      expect(shouldBridge(name)).toBe(false);
    }
  });
});
