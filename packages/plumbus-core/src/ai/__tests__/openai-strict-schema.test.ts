import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createOpenAIStrictOutputStreamUnwrapper,
  restoreOmittedOptionalProperties,
  toOpenAIStrictJsonSchema,
  toOpenAIStrictOutputSchema,
  unwrapOpenAIStrictOutput,
} from '../openai-strict-schema.js';
import { zodToProviderJsonSchema } from '../zod-to-provider-schema.js';

const lessonSchema = z.object({
  title: z.string(),
  note: z.string().optional(),
  kept: z.string().nullable(),
  either: z.string().nullish(),
  mode: z.enum(['draft', 'final']).optional(),
  count: z.number().int().optional(),
  label: z.string().default('untitled'),
  owner: z.object({ id: z.string(), email: z.string().optional() }).nullable().optional(),
  items: z
    .array(
      z.object({
        label: z.string(),
        weight: z.number().optional(),
        detail: z.object({ text: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  step: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), body: z.string(), hint: z.string().optional() }),
    z.object({
      kind: z.literal('choice'),
      options: z.array(z.string()),
      correct: z.number().nullable().optional(),
    }),
  ]),
});

function neutralSchema(schema: z.ZodTypeAny = lessonSchema): Record<string, unknown> {
  return zodToProviderJsonSchema(schema, { promptName: 'lesson' }).schema;
}

/** Every object node reachable in `schema`, so invariants can be checked over the whole tree. */
function collectObjectNodes(schema: unknown, found: Record<string, unknown>[] = []) {
  if (Array.isArray(schema)) {
    for (const child of schema) collectObjectNodes(child, found);
    return found;
  }
  if (typeof schema !== 'object' || schema === null) return found;
  const node = schema as Record<string, unknown>;
  if (typeof node.properties === 'object' && node.properties !== null) found.push(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'enum' || key === 'const') continue;
    collectObjectNodes(child, found);
  }
  return found;
}

/** What OpenAI sends back for an answer, then what the service validates. */
function roundTrip(answer: unknown) {
  const schema = neutralSchema();
  return lessonSchema.parse(restoreOmittedOptionalProperties(answer, schema));
}

describe('toOpenAIStrictJsonSchema', () => {
  it('lists every property as required and lets the optional one be null', () => {
    const strict = toOpenAIStrictJsonSchema(
      neutralSchema(z.object({ a: z.string(), b: z.string().optional() })),
    );

    expect(strict).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: ['string', 'null'] } },
      required: ['a', 'b'],
      additionalProperties: false,
    });
  });

  it('requires every key of every object: nested objects, array items and union branches', () => {
    const objects = collectObjectNodes(toOpenAIStrictJsonSchema(neutralSchema()));

    // root, owner, items[], items[].detail, and the two step branches
    expect(objects).toHaveLength(6);
    for (const node of objects) {
      expect(node.required).toEqual(Object.keys(node.properties as Record<string, unknown>));
      expect(node.additionalProperties).toBe(false);
    }
  });

  it('widens each optional property to accept null, by its shape', () => {
    const strict = toOpenAIStrictJsonSchema(neutralSchema());
    const properties = strict.properties as Record<string, Record<string, unknown>>;

    expect(properties.title).toEqual({ type: 'string' });
    expect(properties.note).toEqual({ type: ['string', 'null'] });
    expect(properties.count).toEqual({ type: ['integer', 'null'] });
    // Strict mode has no `default`: the value is named instead, and Zod fills it in for the null.
    expect(properties.label).toEqual({
      type: ['string', 'null'],
      description: 'Defaults to "untitled".',
    });
    // Enums keep their values and gain a null branch instead of a null enum member.
    expect(properties.mode).toEqual({
      anyOf: [{ type: 'string', enum: ['draft', 'final'] }, { type: 'null' }],
    });
    expect(properties.items?.anyOf).toEqual([
      expect.objectContaining({ type: 'array' }),
      { type: 'null' },
    ]);

    const itemSchema = (properties.items?.anyOf as Record<string, unknown>[])[0]?.items as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(itemSchema.properties?.weight).toEqual({ type: ['number', 'null'] });
    expect(itemSchema.properties?.detail?.anyOf).toEqual([
      {
        type: 'object',
        properties: { text: { type: ['string', 'null'] } },
        required: ['text'],
        additionalProperties: false,
      },
      { type: 'null' },
    ]);

    const [textBranch, choiceBranch] = properties.step?.anyOf as Record<
      string,
      Record<string, unknown>
    >[];
    expect(textBranch?.properties?.hint).toEqual({ type: ['string', 'null'] });
    expect(choiceBranch?.properties?.correct).toEqual({ type: ['number', 'null'] });
  });

  it('leaves properties that already accept null as they are', () => {
    const strict = toOpenAIStrictJsonSchema(neutralSchema());
    const properties = strict.properties as Record<string, Record<string, unknown>>;

    // required + nullable, optional + nullable (nullish), optional + nullable object
    expect(properties.kept).toEqual({ type: ['string', 'null'] });
    expect(properties.either).toEqual({ type: ['string', 'null'] });
    expect(properties.owner?.anyOf).toHaveLength(2);
    expect((properties.owner?.anyOf as unknown[])[1]).toEqual({ type: 'null' });
  });

  it('adds the null branch to an existing union and wraps consts', () => {
    const strict = toOpenAIStrictJsonSchema({
      type: 'object',
      properties: {
        shape: {
          description: 'A shape.',
          anyOf: [
            { type: 'object', properties: {}, additionalProperties: false },
            { type: 'string', const: 'none' },
          ],
        },
        flag: { type: 'string', const: 'on' },
      },
      required: [],
      additionalProperties: false,
    });

    expect(strict.properties).toEqual({
      shape: {
        description: 'A shape.',
        anyOf: [
          { type: 'object', properties: {}, required: [], additionalProperties: false },
          { type: 'string', const: 'none' },
          { type: 'null' },
        ],
      },
      flag: { anyOf: [{ type: 'string', const: 'on' }, { type: 'null' }] },
    });
    expect(strict.required).toEqual(['shape', 'flag']);
  });

  it('does not mutate the provider-neutral schema it is given', () => {
    const schema = neutralSchema();
    const before = JSON.stringify(schema);

    const first = toOpenAIStrictJsonSchema(schema);
    const second = toOpenAIStrictJsonSchema(schema);

    expect(JSON.stringify(schema)).toBe(before);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('toOpenAIStrictJsonSchema string formats', () => {
  // The formats OpenAI lists for strict mode (Structured Outputs guide, "Supported properties").
  const openAIFormats = [
    'date-time',
    'time',
    'date',
    'duration',
    'email',
    'hostname',
    'ipv4',
    'ipv6',
    'uuid',
  ];
  const linkSchema = z.object({
    homepage: z.string().url(),
    source: z.string().url().describe('Where the text came from').optional(),
    links: z.array(z.object({ href: z.string().url() })),
    step: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('video'), url: z.string().url() }),
      z.object({ kind: z.literal('text'), body: z.string() }),
    ]),
    contact: z.string().email(),
    id: z.string().guid(),
    at: z.string().datetime(),
    day: z.string().date(),
    clock: z.string().time(),
    span: z.string().duration(),
    address: z.union([z.ipv4(), z.ipv6()]),
  });

  function collectFormats(schema: unknown, found: string[] = []): string[] {
    if (Array.isArray(schema)) {
      for (const child of schema) collectFormats(child, found);
      return found;
    }
    if (typeof schema !== 'object' || schema === null) return found;
    const node = schema as Record<string, unknown>;
    if (typeof node.format === 'string') found.push(node.format);
    for (const [key, child] of Object.entries(node)) {
      if (key === 'properties' && typeof child === 'object' && child !== null) {
        for (const property of Object.values(child)) collectFormats(property, found);
      } else if (key !== 'enum' && key !== 'const') {
        collectFormats(child, found);
      }
    }
    return found;
  }

  it('sends only the formats OpenAI accepts, anywhere in the tree', () => {
    const neutral = neutralSchema(linkSchema);
    expect(collectFormats(neutral)).toContain('uri');

    const formats = collectFormats(toOpenAIStrictJsonSchema(neutral));

    expect(formats).not.toContain('uri');
    expect(formats.every((format) => openAIFormats.includes(format))).toBe(true);
    expect(new Set(formats)).toEqual(
      new Set(['email', 'uuid', 'date-time', 'date', 'time', 'duration', 'ipv4', 'ipv6']),
    );
  });

  it('names a dropped format in the description of the property it came from', () => {
    const strict = toOpenAIStrictJsonSchema(neutralSchema(linkSchema));
    const properties = strict.properties as Record<string, any>;

    expect(properties.homepage).toEqual({
      type: 'string',
      description: 'Expected string format: uri.',
    });
    expect(properties.source).toEqual({
      type: ['string', 'null'],
      description: 'Where the text came from Expected string format: uri.',
    });
    expect(properties.links.items.properties.href).toEqual({
      type: 'string',
      description: 'Expected string format: uri.',
    });
    const videoBranch = properties.step.anyOf.find(
      (branch: Record<string, any>) => branch.properties.kind.const === 'video',
    );
    expect(videoBranch.properties.url).toEqual({
      type: 'string',
      description: 'Expected string format: uri.',
    });
    expect(properties.contact).toEqual({ type: 'string', format: 'email' });
  });

  it('keeps the format in the neutral schema and in the Zod check of the answer', () => {
    const neutral = neutralSchema(linkSchema);
    const before = JSON.stringify(neutral);
    toOpenAIStrictJsonSchema(neutral);
    expect(JSON.stringify(neutral)).toBe(before);

    const answer = {
      homepage: 'not a url',
      source: null,
      links: [],
      step: { kind: 'text', body: 'Read it' },
      contact: 'a@example.com',
      id: '6f1c2a3e-8a0b-4c1d-9e2f-0a1b2c3d4e5f',
      at: '2026-10-11T10:00:00Z',
      day: '2026-10-11',
      clock: '10:00:00',
      span: 'P1D',
      address: '192.0.2.1',
    };
    const restored = restoreOmittedOptionalProperties(answer, neutral);
    expect(linkSchema.safeParse(restored).success).toBe(false);
    expect(
      linkSchema.parse(
        restoreOmittedOptionalProperties({ ...answer, homepage: 'https://example.com' }, neutral),
      ),
    ).toMatchObject({ homepage: 'https://example.com' });
  });
});

describe('restoreOmittedOptionalProperties', () => {
  const strictAnswer = {
    title: 'Fractions',
    note: null,
    kept: null,
    either: null,
    mode: null,
    count: null,
    label: null,
    owner: null,
    items: [
      { label: 'warm-up', weight: null, detail: { text: null } },
      { label: 'practice', weight: 2, detail: null },
    ],
    step: { kind: 'text', body: 'Read', hint: null },
  };

  it('turns the nulls of omitted optional properties back into absent properties', () => {
    expect(roundTrip(strictAnswer)).toEqual({
      title: 'Fractions',
      kept: null,
      either: null,
      label: 'untitled',
      owner: null,
      items: [
        { label: 'warm-up', detail: {} },
        { label: 'practice', weight: 2 },
      ],
      step: { kind: 'text', body: 'Read' },
    });
  });

  it('keeps null where the schema itself allows null', () => {
    const restored = restoreOmittedOptionalProperties(strictAnswer, neutralSchema()) as Record<
      string,
      unknown
    >;

    expect(restored).toHaveProperty('kept', null);
    expect(restored).toHaveProperty('either', null);
    expect(restored).toHaveProperty('owner', null);
    expect(restored).not.toHaveProperty('note');
    expect(restored).not.toHaveProperty('mode');
    expect(restored).not.toHaveProperty('items.0.weight');
  });

  it('resolves union branches: drops an optional null, keeps a nullable null', () => {
    expect(
      roundTrip({ ...strictAnswer, step: { kind: 'choice', options: ['a'], correct: null } }).step,
    ).toEqual({ kind: 'choice', options: ['a'], correct: null });
    expect(
      roundTrip({ ...strictAnswer, step: { kind: 'text', body: 'Read', hint: 'slowly' } }).step,
    ).toEqual({ kind: 'text', body: 'Read', hint: 'slowly' });
  });

  it('reaches optionals inside a nullable object and inside a union in array items', () => {
    const schema = z.object({
      owner: z.object({ id: z.string(), email: z.string().optional() }).nullable(),
      blocks: z
        .array(
          z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('text'), body: z.string(), hint: z.string().optional() }),
            z.object({
              kind: z.literal('quiz'),
              items: z.array(z.object({ q: z.string(), points: z.number().optional() })),
              due: z.string().nullish(),
            }),
          ]),
        )
        .optional(),
    });
    const answer = {
      owner: { id: 'u1', email: null },
      blocks: [
        { kind: 'text', body: 'Read', hint: null },
        { kind: 'quiz', items: [{ q: 'Why?', points: null }], due: null },
      ],
    };

    expect(schema.parse(restoreOmittedOptionalProperties(answer, neutralSchema(schema)))).toEqual({
      owner: { id: 'u1' },
      blocks: [
        { kind: 'text', body: 'Read' },
        { kind: 'quiz', items: [{ q: 'Why?' }], due: null },
      ],
    });
    // The projection is a fixed point: a second pass changes nothing.
    const strict = toOpenAIStrictJsonSchema(neutralSchema(schema));
    expect(toOpenAIStrictJsonSchema(strict)).toEqual(strict);
  });

  it('returns an answer that already fits the schema unchanged', () => {
    const answer = {
      title: 'Fractions',
      kept: null,
      either: null,
      owner: { id: 'u1' },
      items: [{ label: 'warm-up', detail: { text: 'go' } }],
      step: { kind: 'choice', options: ['a', 'b'], correct: null },
    };

    expect(restoreOmittedOptionalProperties(answer, neutralSchema())).toEqual(answer);
  });

  it('leaves what it cannot place for the Zod schema to report', () => {
    const schema = neutralSchema();
    const unknownBranch = { ...strictAnswer, step: { kind: 'video', hint: null } };
    const restored = restoreOmittedOptionalProperties(unknownBranch, schema) as Record<
      string,
      unknown
    >;

    expect(restored.step).toEqual({ kind: 'video', hint: null });
    expect(() => lessonSchema.parse(restored)).toThrow();
    // A required property that comes back null is not "omitted": validation still rejects it.
    expect(() => roundTrip({ ...strictAnswer, title: null })).toThrow();
  });

  it('keeps a __proto__ key in the answer as data', () => {
    const answer = JSON.parse('{"title":"t","kept":null,"__proto__":{"polluted":true}}');
    const restored = restoreOmittedOptionalProperties(answer, neutralSchema()) as Record<
      string,
      unknown
    >;

    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Object.hasOwn(restored, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/** Every key named `key` anywhere in `schema` (property names excluded), with its value. */
function collectKeyword(schema: unknown, key: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(schema)) {
    for (const child of schema) collectKeyword(child, key, found);
    return found;
  }
  if (typeof schema !== 'object' || schema === null) return found;
  for (const [name, child] of Object.entries(schema)) {
    if (name === key) found.push(child);
    if (name === 'properties' && typeof child === 'object' && child !== null) {
      for (const property of Object.values(child)) collectKeyword(property, key, found);
    } else if (name !== 'enum' && name !== 'const') {
      collectKeyword(child, key, found);
    }
  }
  return found;
}

/** Every schema node anywhere in `schema` that has the keyword `key`. */
function collectNodesWith(
  schema: unknown,
  key: string,
  found: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(schema)) {
    for (const child of schema) collectNodesWith(child, key, found);
    return found;
  }
  if (typeof schema !== 'object' || schema === null) return found;
  const node = schema as Record<string, unknown>;
  if (key in node) found.push(node);
  for (const [name, child] of Object.entries(node)) {
    if (name === 'properties' && typeof child === 'object' && child !== null) {
      for (const property of Object.values(child)) collectNodesWith(property, key, found);
    } else if (name !== 'enum' && name !== 'const') {
      collectNodesWith(child, key, found);
    }
  }
  return found;
}

const unionKeys = new Set(['anyOf', 'description', 'title']);

describe('toOpenAIStrictJsonSchema allOf (strict mode has no allOf)', () => {
  const ipv4Cidr = '10.0.0.0/8';
  const ipv6Cidr = '2001:db8::/32';

  it('sends the two patterns of z.union([z.cidrv4(), z.cidrv6()]) as alternatives, so both IP versions stay possible', () => {
    const schema = z.object({ network: z.union([z.cidrv4(), z.cidrv6()]) });
    const neutral = neutralSchema(schema);
    // The neutral schema already joins them (zod-to-json-schema's allOf would require both).
    expect(collectKeyword(neutral, 'allOf')).toEqual([]);

    const strict = toOpenAIStrictJsonSchema(neutral);
    const network = (strict.properties as Record<string, Record<string, unknown>>).network;

    expect(collectKeyword(strict, 'allOf')).toEqual([]);
    // Either pattern alone would refuse the other IP version, which Zod accepts.
    const branches = network?.anyOf as Record<string, unknown>[];
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.type).toBe('string');
      expect(new RegExp(String(branch.pattern)).test('not a network')).toBe(false);
    }
    expect(new RegExp(String(branches[0]?.pattern)).test(ipv4Cidr)).toBe(true);
    expect(new RegExp(String(branches[1]?.pattern)).test(ipv6Cidr)).toBe(true);
    // Zod still checks the original.
    expect(schema.parse(restoreOmittedOptionalProperties({ network: ipv4Cidr }, neutral))).toEqual({
      network: ipv4Cidr,
    });
    expect(schema.parse(restoreOmittedOptionalProperties({ network: ipv6Cidr }, neutral))).toEqual({
      network: ipv6Cidr,
    });
    expect(schema.safeParse({ network: 'not a network' }).success).toBe(false);
  });

  it('names every pattern of a string with several (.regex().regex()) in its description', () => {
    const strict = toOpenAIStrictJsonSchema(
      neutralSchema(z.object({ code: z.string().regex(/^a/).regex(/z$/) })),
    );

    expect(strict.properties).toEqual({
      code: { type: 'string', description: 'Must match pattern: ^a. Must match pattern: z$.' },
    });
  });

  it('merges an intersection into one object, optional members included', () => {
    const schema = z.object({ title: z.string(), meta: z.object({ id: z.string() }) }).and(
      z.object({
        note: z.string().optional(),
        meta: z.object({ tag: z.string().optional() }),
      }),
    );
    const neutral = neutralSchema(schema);
    // Merged already in the neutral schema, for every provider.
    expect(neutral).not.toHaveProperty('allOf');

    const strict = toOpenAIStrictJsonSchema(neutral);

    expect(strict).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        meta: {
          type: 'object',
          properties: { id: { type: 'string' }, tag: { type: ['string', 'null'] } },
          required: ['id', 'tag'],
          additionalProperties: false,
        },
        note: { type: ['string', 'null'] },
      },
      required: ['title', 'meta', 'note'],
      additionalProperties: false,
    });
    // The answer strict mode produces validates against the original intersection.
    const answer = { title: 'T', meta: { id: 'm1', tag: null }, note: null };
    expect(schema.parse(restoreOmittedOptionalProperties(answer, neutral))).toEqual({
      title: 'T',
      meta: { id: 'm1' },
    });
  });

  it('keeps one of two different patterns a shared property has and names the other', () => {
    const strict = toOpenAIStrictJsonSchema(
      neutralSchema(
        z
          .object({ code: z.string().regex(/^[A-Z]+$/) })
          .and(z.object({ code: z.string().regex(/^.{3}$/) })),
      ),
    );

    expect((strict.properties as Record<string, unknown>).code).toEqual({
      type: 'string',
      pattern: '^[A-Z]+$',
      description: 'Must match pattern: ^.{3}$.',
    });
  });

  it('intersects types and enums, and distributes one union over another', () => {
    const strict = toOpenAIStrictJsonSchema({
      allOf: [
        {
          anyOf: [
            { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
            { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
          ],
        },
        {
          anyOf: [
            { type: 'object', properties: { c: { type: 'number' } }, required: ['c'] },
            { type: 'object', properties: { d: { type: ['number', 'string'] } }, required: ['d'] },
          ],
        },
      ],
    });
    expect((strict.anyOf as Record<string, unknown>[]).map((branch) => branch.required)).toEqual([
      ['a', 'c'],
      ['a', 'd'],
      ['b', 'c'],
      ['b', 'd'],
    ]);

    expect(
      toOpenAIStrictJsonSchema({
        type: 'object',
        properties: {
          n: { allOf: [{ type: ['number', 'null'] }, { type: 'integer' }] },
          e: { allOf: [{ enum: ['a', 'b', 'c'] }, { enum: ['b', 'c', 'd'] }] },
        },
        required: ['n', 'e'],
        additionalProperties: false,
      }).properties,
    ).toEqual({ n: { type: 'integer' }, e: { enum: ['b', 'c'] } });
  });

  it('moves an object intersected with a union into each branch, and the answer round-trips', () => {
    // Merged as is, the object's properties would sit next to the union's anyOf, whose branches
    // each say additionalProperties: false: no answer could carry both.
    const schema = z
      .object({ title: z.string(), note: z.string().optional() })
      .and(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('text'), body: z.string(), hint: z.string().optional() }),
          z.object({ kind: z.literal('count'), n: z.number() }),
        ]),
      );
    const neutral = neutralSchema(schema);

    const strict = toOpenAIStrictJsonSchema(neutral);

    expect(strict).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: {
            title: { type: 'string' },
            note: { type: ['string', 'null'] },
            kind: { type: 'string', const: 'text' },
            body: { type: 'string' },
            hint: { type: ['string', 'null'] },
          },
          required: ['title', 'note', 'kind', 'body', 'hint'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            title: { type: 'string' },
            note: { type: ['string', 'null'] },
            kind: { type: 'string', const: 'count' },
            n: { type: 'number' },
          },
          required: ['title', 'note', 'kind', 'n'],
          additionalProperties: false,
        },
      ],
    });
    // A union root, so the request sends it in the envelope.
    expect(toOpenAIStrictOutputSchema(neutral).enveloped).toBe(true);

    const answer = { title: 'T', note: null, kind: 'text', body: 'B', hint: null };
    expect(schema.parse(restoreOmittedOptionalProperties(answer, neutral))).toEqual({
      title: 'T',
      kind: 'text',
      body: 'B',
    });
    const count = { title: 'T', note: 'n', kind: 'count', n: 2 };
    expect(restoreOmittedOptionalProperties(count, neutral)).toEqual(count);
  });

  it('restores the optionals of an intersection inside a union (a nullable intersection)', () => {
    const schema = z
      .object({ a: z.string() })
      .and(z.object({ b: z.string().optional() }))
      .nullable();
    const neutral = neutralSchema(schema);

    expect(schema.parse(restoreOmittedOptionalProperties({ a: 'A', b: null }, neutral))).toEqual({
      a: 'A',
    });
    expect(restoreOmittedOptionalProperties(null, neutral)).toBeNull();
  });

  it('gives each branch of z.union([z.ipv4(), z.ipv6()]) the type it shares, optional or not', () => {
    const strict = toOpenAIStrictJsonSchema(
      neutralSchema(
        z.object({
          host: z.union([z.ipv4(), z.ipv6()]),
          backup: z.union([z.ipv4(), z.ipv6()]).optional(),
        }),
      ),
    );

    expect(strict.properties).toEqual({
      host: {
        anyOf: [
          { type: 'string', format: 'ipv4' },
          { type: 'string', format: 'ipv6' },
        ],
      },
      backup: {
        anyOf: [
          { type: 'string', format: 'ipv4' },
          { type: 'string', format: 'ipv6' },
          { type: 'null' },
        ],
      },
    });
  });

  it('leaves no allOf anywhere, does not mutate its input, and is a fixed point', () => {
    const schema = z.object({
      network: z.union([z.cidrv4(), z.cidrv6()]),
      items: z.array(
        z
          .object({ a: z.string() })
          .and(z.object({ b: z.union([z.cidrv4(), z.cidrv6()]).optional() })),
      ),
      choice: z.union([
        z.object({ kind: z.literal('x') }).and(z.object({ x: z.string().regex(/^a/).regex(/b$/) })),
        z.object({ kind: z.literal('y') }),
      ]),
      tagged: z
        .object({ id: z.string() })
        .and(
          z.union([
            z.object({ ip: z.union([z.ipv4(), z.ipv6()]) }),
            z.object({ n: z.number().optional() }),
          ]),
        )
        .optional(),
    });
    const neutral = neutralSchema(schema);
    const before = JSON.stringify(neutral);

    const strict = toOpenAIStrictJsonSchema(neutral);

    expect(collectKeyword(strict, 'allOf')).toEqual([]);
    expect(JSON.stringify(neutral)).toBe(before);
    expect(toOpenAIStrictJsonSchema(strict)).toEqual(strict);
    for (const node of collectObjectNodes(strict)) {
      expect(node.required).toEqual(Object.keys(node.properties as Record<string, unknown>));
      expect(node.additionalProperties).toBe(false);
    }
    // A union carries nothing but its branches (and a description or title).
    const unions = collectNodesWith(strict, 'anyOf');
    expect(unions.length).toBeGreaterThan(0);
    for (const node of unions) {
      expect(Object.keys(node).filter((key) => !unionKeys.has(key))).toEqual([]);
    }
  });
});

describe('toOpenAIStrictOutputSchema (strict mode needs an object root)', () => {
  it('sends an object root as it is', () => {
    const neutral = neutralSchema(z.object({ a: z.string(), b: z.string().optional() }));

    expect(toOpenAIStrictOutputSchema(neutral)).toEqual({
      schema: toOpenAIStrictJsonSchema(neutral),
      enveloped: false,
    });
  });

  it('sends an array root (classify) as the single property `value` of an object', () => {
    expect(toOpenAIStrictOutputSchema(neutralSchema(z.array(z.string())))).toEqual({
      schema: {
        type: 'object',
        properties: { value: { type: 'array', items: { type: 'string' } } },
        required: ['value'],
        additionalProperties: false,
      },
      enveloped: true,
    });
  });

  it.each([
    ['a union', z.union([z.object({ a: z.string() }), z.object({ b: z.number() })])],
    ['a discriminated union', z.discriminatedUnion('k', [z.object({ k: z.literal('a') })])],
    ['a nullable object', z.object({ a: z.string() }).nullable()],
    ['an enum', z.enum(['low', 'high'])],
    ['a number', z.number()],
    ['an array of objects', z.array(z.object({ a: z.string().optional() }))],
  ])('envelopes %s, whose inner schema is still strict', (_label, zodSchema) => {
    const neutral = neutralSchema(zodSchema);
    const { schema, enveloped } = toOpenAIStrictOutputSchema(neutral);

    expect(enveloped).toBe(true);
    expect(schema).toEqual({
      type: 'object',
      properties: { value: toOpenAIStrictJsonSchema(neutral) },
      required: ['value'],
      additionalProperties: false,
    });
  });

  it('does not envelope an intersection of objects: it merges into one object', () => {
    const neutral = neutralSchema(z.object({ a: z.string() }).and(z.object({ b: z.string() })));

    const { schema, enveloped } = toOpenAIStrictOutputSchema(neutral);

    expect(enveloped).toBe(false);
    expect(schema).toMatchObject({ type: 'object', required: ['a', 'b'] });
  });
});

describe('unwrapOpenAIStrictOutput', () => {
  it('takes the answer out of the envelope as JSON text', () => {
    expect(unwrapOpenAIStrictOutput('{"value":["billing","urgent"]}')).toBe('["billing","urgent"]');
    expect(unwrapOpenAIStrictOutput('{ "value" : {"a":null} }')).toBe('{"a":null}');
    expect(unwrapOpenAIStrictOutput('{"value":"low"}')).toBe('"low"');
    expect(unwrapOpenAIStrictOutput('{"value":null}')).toBe('null');
  });

  it('returns anything that is not exactly the envelope unchanged', () => {
    for (const content of [
      'not json',
      '["a"]',
      '{"value":1,"other":2}',
      '{}',
      '{"other":["a"',
      // A complete value with something after it is not an answer cut off; validation reports it.
      '{"value":["a"]} trailing',
    ]) {
      expect(unwrapOpenAIStrictOutput(content)).toBe(content);
    }
  });

  it('takes an answer cut off inside the envelope out of it, as a stream of it would be', () => {
    // max_tokens ends the answer mid-value: partialText should hold the answer, not the envelope.
    expect(unwrapOpenAIStrictOutput('{"value":["a"')).toBe('["a"');
    expect(unwrapOpenAIStrictOutput('{"value": [{"name":"x","note":"a } b')).toBe(
      '[{"name":"x","note":"a } b',
    );
    expect(unwrapOpenAIStrictOutput('{"value":"lo')).toBe('"lo');
    expect(unwrapOpenAIStrictOutput('{"value":')).toBe('');
  });
});

describe('createOpenAIStrictOutputStreamUnwrapper', () => {
  /** Feed `text` in pieces of `size` characters, as stream deltas arrive. */
  function unwrapInPieces(text: string, size: number): string {
    const unwrapper = createOpenAIStrictOutputStreamUnwrapper();
    let out = '';
    for (let index = 0; index < text.length; index += size) {
      out += unwrapper.push(text.slice(index, index + size));
    }
    return out + unwrapper.end();
  }

  const envelopes: [string, string][] = [
    ['{"value":["a","b"]}', '["a","b"]'],
    ['{"value":[{"t":"} ] \\" {","n":[1,[2]]}]}', '[{"t":"} ] \\" {","n":[1,[2]]}]'],
    [' {\n  "value" : {"kind":"x","a":null}\n}\n', '{"kind":"x","a":null}'],
    ['{"value":"say \\"hi\\" {there}"}', '"say \\"hi\\" {there}"'],
    ['{"value":-12.5e3}', '-12.5e3'],
    ['{"value":true }', 'true'],
    ['{"value":null}', 'null'],
    ['{"value":["ü😀"]}', '["ü😀"]'],
  ];

  it.each(
    envelopes,
  )('passes on only the answer of %s, however the deltas split it', (text, inner) => {
    for (const size of [1, 2, 3, 5, 8, text.length]) {
      expect(unwrapInPieces(text, size)).toBe(inner);
    }
  });

  it('passes the value on as it arrives, holding back only the opening', () => {
    const unwrapper = createOpenAIStrictOutputStreamUnwrapper();

    expect(unwrapper.push('{"val')).toBe('');
    expect(unwrapper.push('ue":["a",')).toBe('["a",');
    expect(unwrapper.push('"b"]')).toBe('"b"]');
    expect(unwrapper.push('}')).toBe('');
    expect(unwrapper.end()).toBe('');
  });

  it.each([
    '["not","enveloped"]',
    '{"other":1}',
    '{"values":[1]}',
    'plain text',
  ])('passes %s on unchanged when it is not the envelope', (text) => {
    for (const size of [1, 4, text.length]) {
      expect(unwrapInPieces(text, size)).toBe(text);
    }
  });

  it('gives back an opening that the stream never completed', () => {
    expect(unwrapInPieces('{"value"', 3)).toBe('{"value"');
    expect(unwrapInPieces('{"val', 1)).toBe('{"val');
  });

  it('gives back nothing for a complete opening cut off before its value', () => {
    // `{"value":` can only be the envelope, so the answer it would have held is empty.
    expect(unwrapInPieces('{"value": ', 1)).toBe('');
    expect(unwrapInPieces('{"value":', 9)).toBe('');
  });
});
