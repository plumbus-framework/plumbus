// Structured-output schemas every provider can take. The neutral schema (`zodToProviderJsonSchema`,
// sent as it is to Anthropic and Bedrock) may use only the keywords both document and must be
// satisfiable when read strictly; OpenAI's strict projection of it may use only strict-mode
// keywords. In both, the prompt's Zod schema still validates the original.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { definePrompt } from '../../define/definePrompt.js';
import { createAIService, singleProviderConfig } from '../ai-service.js';
import {
  restoreOmittedOptionalProperties,
  toOpenAIStrictJsonSchema,
  toOpenAIStrictOutputSchema,
} from '../openai-strict-schema.js';
import { createAnthropicAdapter } from '../provider.js';
import { zodToProviderJsonSchema } from '../zod-to-provider-schema.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Keywords Anthropic ("JSON Schema limitations", structured outputs) and Bedrock ("Supported JSON
 * Schema features") document for structured outputs, plus the annotations both take.
 */
const neutralKeywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'anyOf',
  'allOf',
  'enum',
  'const',
  'format',
  'pattern',
  'default',
  'description',
  'title',
]);

/** Keywords OpenAI strict mode supports ("Supported schemas", Structured Outputs guide). */
const strictKeywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'anyOf',
  'enum',
  'const',
  'format',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'description',
  'title',
]);

/** Every keyword used anywhere in `schema` (property names and enum/const/default values excluded). */
function keywordsOf(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const child of schema) keywordsOf(child, found);
    return found;
  }
  if (typeof schema !== 'object' || schema === null) return found;
  for (const [key, child] of Object.entries(schema)) {
    found.add(key);
    if (key === 'properties' && typeof child === 'object' && child !== null) {
      for (const property of Object.values(child)) keywordsOf(property, found);
    } else if (key !== 'enum' && key !== 'const' && key !== 'default') {
      keywordsOf(child, found);
    }
  }
  return found;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is valid against `schema` read strictly, as a provider that compiles the schema
 * reads it: every `allOf` member and every object's `additionalProperties: false` apply.
 */
function satisfies(value: unknown, schema: unknown): boolean {
  if (!isObject(schema)) return schema !== false;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (schema.not !== undefined && satisfies(value, schema.not)) return false;
  if ('const' in schema && !same(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(option, value))) {
    return false;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const typeOf = (type: unknown) =>
      (type === 'null' && value === null) ||
      (type === 'string' && typeof value === 'string') ||
      (type === 'number' && typeof value === 'number') ||
      (type === 'integer' && Number.isInteger(value)) ||
      (type === 'boolean' && typeof value === 'boolean') ||
      (type === 'object' && isObject(value)) ||
      (type === 'array' && Array.isArray(value));
    if (!types.some(typeOf)) return false;
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string') {
    if (!new RegExp(schema.pattern).test(value)) return false;
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every((member) => satisfies(value, member))) {
    return false;
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => satisfies(value, branch))) {
    return false;
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (!required.every((key) => Object.hasOwn(value, String(key)))) return false;
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!satisfies(child, properties[key])) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    const positional = Array.isArray(schema.prefixItems)
      ? schema.prefixItems
      : Array.isArray(schema.items)
        ? schema.items
        : [];
    const rest = Array.isArray(schema.items) ? schema.additionalItems : schema.items;
    for (const [index, item] of value.entries()) {
      const itemSchema = index < positional.length ? positional[index] : rest;
      if (itemSchema !== undefined && !satisfies(item, itemSchema)) return false;
    }
  }
  return true;
}

function neutral(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToProviderJsonSchema(schema, { promptName: 'subset' }).schema;
}

const card = z.object({ title: z.string() });

/** Output shapes zod-to-json-schema emits outside the providers' subsets, one per row. */
const shapes: [string, z.ZodTypeAny][] = [
  ['an intersection of objects', card.and(z.object({ note: z.string().optional() }))],
  [
    'an object intersected with a discriminated union',
    card.and(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('text'), body: z.string() }),
        z.object({ kind: z.literal('count'), n: z.number() }),
      ]),
    ),
  ],
  [
    'an object intersected with an optional object',
    card.and(z.object({ n: z.number() }).optional()),
  ],
  [
    'an object intersected with a nullable object',
    card.and(z.object({ n: z.number() }).nullable()),
  ],
  ['a cidr() string', z.object({ network: z.string().cidr() })],
  [
    'a cidr() string with another pattern',
    z.object({ network: z.string().cidr().startsWith('10.') }),
  ],
  ['a string with two patterns', z.object({ code: z.string().regex(/^a/).regex(/z$/) })],
  ['an ip() string', z.object({ host: z.string().ip() })],
  ['an optional root', card.optional()],
  ['an array of optional items', z.object({ tags: z.array(z.string().optional()) })],
  ['a tuple', z.object({ point: z.tuple([z.string(), z.number()]) })],
  ['a tuple with a rest', z.object({ row: z.tuple([z.string()]).rest(z.number()) })],
  ['a root tuple', z.tuple([z.string(), z.boolean()])],
  ['a default', z.object({ label: z.string().default('untitled'), size: z.number().default(3) })],
  [
    'all of them nested',
    z.object({
      items: z.array(card.and(z.object({ network: z.string().cidr().optional() }))),
      pair: z.tuple([z.string().default('x'), z.number()]).optional(),
    }),
  ],
];

/**
 * Paths of the nodes in `schema` that have no `type` and are not a union or intersection: the
 * shape Anthropic's SDK refuses to send ("JSON schema must have a type defined if anyOf/oneOf/allOf
 * are not used"), which is how every node of a schema it sends looks.
 */
function untypedNodes(schema: unknown, path = '#', found: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const [index, child] of schema.entries()) untypedNodes(child, `${path}[${index}]`, found);
    return found;
  }
  if (!isObject(schema)) return found;
  if (!('type' in schema) && !('anyOf' in schema) && !('allOf' in schema)) found.push(path);
  for (const [key, child] of Object.entries(schema)) {
    if (key === 'properties' && isObject(child)) {
      for (const [name, property] of Object.entries(child)) {
        untypedNodes(property, `${path}.properties.${name}`, found);
      }
    } else if (key === 'items' || key === 'anyOf' || key === 'allOf') {
      untypedNodes(child, `${path}.${key}`, found);
    }
  }
  return found;
}

describe('the neutral schema Anthropic and Bedrock receive', () => {
  it.each(shapes)('uses only documented keywords for %s', (_label, schema) => {
    const unsupported = [...keywordsOf(neutral(schema))].filter((key) => !neutralKeywords.has(key));
    expect(unsupported).toEqual([]);
  });

  it.each(
    shapes,
  )('gives every node that is not a union or intersection a type for %s', (_label, schema) => {
    expect(untypedNodes(neutral(schema))).toEqual([]);
  });

  it('drops the union branches an intersection rules out instead of describing them', () => {
    const merged = {
      type: 'object',
      properties: { title: { type: 'string' }, n: { type: 'number' } },
      required: ['title', 'n'],
      additionalProperties: false,
    };
    // .optional(): the never-matching { not: {} } branch was merged into a branch that carried it.
    const optional = card.and(z.object({ n: z.number() }).optional());
    expect(neutral(optional)).toEqual(merged);
    // .nullable(): the null branch became an object branch accepting { title } alone, which Zod
    // refuses (the right side is an object without n, not null).
    const nullable = card.and(z.object({ n: z.number() }).nullable());
    expect(neutral(nullable)).toEqual(merged);
    expect(nullable.safeParse({ title: 'T' }).success).toBe(false);
    expect(satisfies({ title: 'T' }, neutral(nullable))).toBe(false);

    // Two discriminated unions on the same key: only the branches whose kinds meet.
    const both = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), x: z.string() }),
        z.object({ kind: z.literal('b'), y: z.string() }),
      ])
      .and(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('a'), p: z.number() }),
          z.object({ kind: z.literal('b'), q: z.number() }),
        ]),
      );
    const sent = neutral(both);
    expect(sent.anyOf).toHaveLength(2);
    for (const answer of [
      { kind: 'a', x: 'X', p: 1 },
      { kind: 'b', y: 'Y', q: 2 },
    ]) {
      expect(satisfies(answer, sent)).toBe(true);
      expect(both.parse(answer)).toEqual(answer);
    }
    expect(JSON.stringify(sent)).not.toContain('Must also satisfy');
  });

  it('merges an intersection of objects into one object an answer with both sides can satisfy', () => {
    const schema = card.and(z.object({ note: z.string().optional() }));
    const sent = neutral(schema);

    // As allOf, each member's additionalProperties: false refused the other member's keys.
    expect(sent).toEqual({
      type: 'object',
      properties: { title: { type: 'string' }, note: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    });
    expect(satisfies({ title: 'T', note: 'n' }, sent)).toBe(true);
    expect(satisfies({ title: 'T' }, sent)).toBe(true);
    expect(satisfies({ note: 'n' }, sent)).toBe(false);
    expect(zodToProviderJsonSchema(schema).optionalParameterCount).toBe(1);
  });

  it('spreads an object intersected with a union into each branch', () => {
    const schema = card.and(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('text'), body: z.string() }),
        z.object({ kind: z.literal('count'), n: z.number() }),
      ]),
    );
    const sent = neutral(schema);

    expect(Object.keys(sent)).toEqual(['anyOf']);
    for (const answer of [
      { title: 'T', kind: 'text', body: 'B' },
      { title: 'T', kind: 'count', n: 2 },
    ]) {
      expect(satisfies(answer, sent)).toBe(true);
      expect(schema.parse(answer)).toEqual(answer);
    }
    expect(satisfies({ title: 'T', kind: 'count', body: 'B' }, sent)).toBe(false);
  });

  it('sends both the IPv4 and the IPv6 pattern of cidr() as alternatives', () => {
    const schema = z.object({ network: z.string().cidr() });
    const sent = neutral(schema);

    // zod-to-json-schema lists them in allOf (both required), and the IPv4 one, which uses
    // non-capturing groups, was only described: the provider allowed IPv6 networks alone.
    for (const network of ['10.0.0.0/8', '192.168.1.0/24', '2001:db8::/32']) {
      expect(satisfies({ network }, sent)).toBe(true);
      expect(schema.parse({ network })).toEqual({ network });
    }
    expect(satisfies({ network: '10.0.0.1' }, sent)).toBe(false);
    expect(satisfies({ network: 'not a network' }, sent)).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('Must match pattern');
    expect(zodToProviderJsonSchema(schema).unionParameterCount).toBe(1);
  });

  it('keeps cidr() an alternative next to another pattern', () => {
    const sent = neutral(z.object({ network: z.string().cidr().startsWith('10.') }));
    const network = (sent.properties as Record<string, Record<string, unknown>>).network;

    expect(satisfies('10.0.0.0/8', network)).toBe(true);
    expect(satisfies('192.168.0.0/16', network)).toBe(false);
  });

  it('sends a pattern with non-capturing groups as plain groups, and leaves backreferences described', () => {
    const sent = neutral(
      z.object({
        code: z.string().regex(/^(?:ab)+(?:-[0-9]{2})?$/),
        escaped: z.string().regex(/^\\(?:x)$/),
        twice: z.string().regex(/^(a)\1$/),
      }),
    );
    const properties = sent.properties as Record<string, Record<string, unknown>>;

    expect(properties.code).toEqual({ type: 'string', pattern: '^(ab)+(-[0-9]{2})?$' });
    expect(properties.escaped).toEqual({ type: 'string', pattern: '^\\\\(x)$' });
    expect(properties.twice).toEqual({
      type: 'string',
      description: 'Must match pattern: ^(a)\\1$.',
    });
  });

  it('sends an optional root as the value itself, without the never-matching { not: {} } branch', () => {
    const schema = card.optional();
    const sent = neutral(schema);

    expect(sent).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    });
    expect(neutral(z.object({ tags: z.array(z.string().optional()) })).properties).toEqual({
      tags: { type: 'array', items: { type: 'string' } },
    });
    expect(schema.parse({ title: 'T' })).toEqual({ title: 'T' });
  });

  it('sends a tuple as an array of its item schemas and names the order and length', () => {
    const schema = z.object({ point: z.tuple([z.string(), z.number()]) });
    const result = zodToProviderJsonSchema(schema);
    const point = (result.schema.properties as Record<string, unknown>).point;

    expect(point).toEqual({
      type: 'array',
      items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      minItems: 1,
      description: 'Must hold exactly 2 items, in this order: (1) string; (2) number.',
    });
    expect(result.unionParameterCount).toBe(1);
    expect(satisfies(['a', 1], point)).toBe(true);
    // Zod still checks each position and the length.
    expect(schema.safeParse({ point: ['a', 1] }).success).toBe(true);
    expect(schema.safeParse({ point: [1, 'a'] }).success).toBe(false);
    expect(schema.safeParse({ point: ['a', 1, 2] }).success).toBe(false);
  });

  it('names a tuple rest and keeps one item schema when all positions share it', () => {
    const rows = neutral(
      z.object({
        row: z.tuple([z.string()]).rest(z.number()),
        pair: z.tuple([z.number(), z.number()]),
      }),
    ).properties as Record<string, Record<string, unknown>>;

    expect(rows.row).toEqual({
      type: 'array',
      items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      minItems: 1,
      description: 'Must start with 1 item, in this order: (1) string; then any number of: number.',
    });
    expect(rows.pair?.items).toEqual({ type: 'number' });
  });
});

describe("OpenAI's strict projection of it", () => {
  it.each(shapes)('uses only strict-mode keywords for %s', (_label, schema) => {
    const { schema: sent } = toOpenAIStrictOutputSchema(neutral(schema));
    const unsupported = [...keywordsOf(sent)].filter((key) => !strictKeywords.has(key));
    expect(unsupported).toEqual([]);
  });

  it('sends an optional object root without the envelope', () => {
    const sent = neutral(card.optional());
    expect(toOpenAIStrictOutputSchema(sent)).toEqual({ schema: sent, enveloped: false });
  });

  it('names a default instead of sending it, and Zod fills it in for the null', () => {
    const schema = z.object({ label: z.string().default('untitled'), size: z.number().default(3) });
    const sent = neutral(schema);
    const strict = toOpenAIStrictJsonSchema(sent);

    expect(strict.properties).toEqual({
      label: { type: ['string', 'null'], description: 'Defaults to "untitled".' },
      size: { type: ['number', 'null'], description: 'Defaults to 3.' },
    });
    // Anthropic documents `default`, so the neutral schema keeps it.
    expect((sent.properties as Record<string, Record<string, unknown>>).label?.default).toBe(
      'untitled',
    );
    const answer = { label: null, size: 5 };
    expect(satisfies(answer, strict)).toBe(true);
    expect(schema.parse(restoreOmittedOptionalProperties(answer, sent))).toEqual({
      label: 'untitled',
      size: 5,
    });
  });

  it('accepts and restores the answer to a tuple of objects with optional fields', () => {
    const schema = z.object({
      pair: z.tuple([z.object({ a: z.string().optional() }), z.object({ b: z.number() })]),
    });
    const sent = neutral(schema);
    const strict = toOpenAIStrictJsonSchema(sent);
    const answer = { pair: [{ a: null }, { b: 1 }] };

    expect(satisfies(answer, strict)).toBe(true);
    expect(schema.parse(restoreOmittedOptionalProperties(answer, sent))).toEqual({
      pair: [{}, { b: 1 }],
    });
  });
});

describe('the Anthropic adapter (structured outputs, fake fetch)', () => {
  function answer(text: string) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
      }),
    };
  }

  async function run(output: z.ZodTypeAny, text: string) {
    const mockFetch = vi.fn().mockResolvedValue(answer(text));
    vi.stubGlobal('fetch', mockFetch);
    const ai = createAIService(
      singleProviderConfig(createAnthropicAdapter({ apiKey: 'sk-ant-test' }), {
        enableStrictStructuredOutputs: true,
        prompts: [
          definePrompt({
            name: 'shape',
            description: 'Describe {{x}}',
            input: z.object({ x: z.string() }),
            output,
          }),
        ],
      }),
    );
    const data = await ai.generate({ prompt: 'shape', input: { x: 'lab' } });
    const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1].body));
    return { data, sent: body.output_config.format.schema as Record<string, unknown> };
  }

  it('sends an intersection with a cidr() and a tuple in documented keywords, satisfiable by the answer', async () => {
    const output = card.and(
      z.object({ network: z.string().cidr(), point: z.tuple([z.string(), z.number()]) }),
    );
    const text = '{"title":"T","network":"10.0.0.0/8","point":["a",1]}';

    const { data, sent } = await run(output, text);

    expect(data).toEqual(JSON.parse(text));
    expect([...keywordsOf(sent)].filter((key) => !neutralKeywords.has(key))).toEqual([]);
    expect(satisfies(JSON.parse(text), sent)).toBe(true);
  });

  it('sends an array root as it is: neither Anthropic nor Bedrock asks for an object root', async () => {
    const { data, sent } = await run(z.array(card), '[{"title":"A"},{"title":"B"}]');

    expect(data).toEqual([{ title: 'A' }, { title: 'B' }]);
    expect(sent).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    });
  });

  it('sends an optional root as the object', async () => {
    const { data, sent } = await run(card.optional(), '{"title":"T"}');

    expect(data).toEqual({ title: 'T' });
    expect(sent.type).toBe('object');
    expect(keywordsOf(sent).has('not')).toBe(false);
  });
});
