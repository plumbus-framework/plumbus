import { describe, expect, it } from 'vitest';
import { diffOpenApi } from '../diff.js';
import type { OpenApiDocument } from '../../openapi/types.js';

// ── The same partner contract, spelled in both document dialects ──
//
// OpenAPI 3.0 uses `nullable: true`; OpenAPI 3.1 uses JSON Schema 2020-12, where nullability is
// a `null` member of a type array (primitives) or a `null` branch of an `anyOf` (objects), and a
// single permitted value is `const` rather than a one-member `enum`. The wire payload is
// identical, so re-emitting the contract at 3.1 must not read as a schema change.

function refundResponseSchema(data: Record<string, unknown>): Record<string, unknown> {
  return {
    description: 'Successful response',
    content: {
      'application/json': {
        schema: {
          allOf: [
            { $ref: '#/components/schemas/ApiSuccessEnvelope' },
            { type: 'object', properties: { data } },
          ],
        },
      },
    },
  };
}

function docV30(): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'partner-api', version: '1.0.0' },
    paths: {
      '/refunds/{refundId}': {
        get: {
          operationId: 'getRefund',
          responses: {
            '200': refundResponseSchema({
              type: 'object',
              properties: {
                id: { type: 'string' },
                note: { type: 'string', nullable: true },
                status: { type: 'string', enum: ['open', 'closed'] },
                settled: { type: 'boolean', enum: [true] },
                lineItems: {
                  type: 'object',
                  nullable: true,
                  properties: { count: { type: 'number' } },
                },
              },
              required: ['id', 'status'],
            }),
          },
        },
      },
    },
  };
}

function docV31(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'partner-api', version: '1.0.0' },
    paths: {
      '/refunds/{refundId}': {
        get: {
          operationId: 'getRefund',
          responses: {
            '200': refundResponseSchema({
              type: 'object',
              properties: {
                id: { type: 'string' },
                note: { type: ['string', 'null'] },
                status: { type: 'string', enum: ['open', 'closed'] },
                settled: { type: 'boolean', const: true },
                lineItems: {
                  anyOf: [
                    { type: 'object', properties: { count: { type: 'number' } } },
                    { type: 'null' },
                  ],
                },
              },
              required: ['id', 'status'],
            }),
          },
        },
      },
    },
  };
}

describe('diffOpenApi across OpenAPI document versions', () => {
  it('reports a 3.0 → 3.1 migration as a single non-breaking version change', () => {
    const diff = diffOpenApi(docV30(), docV31());

    expect(diff.breaking).toEqual([]);
    expect(diff.nonBreaking.map((e) => e.kind)).toEqual(['changed-openapi-version']);
    expect(diff.nonBreaking[0]?.message).toContain('3.0.3 → 3.1.0');
    expect(diff.nonBreaking[0]?.message).toContain('wire contract is unchanged');
  });

  it('reports a 3.1 → 3.0 downgrade the same way (dialect only, never breaking)', () => {
    const diff = diffOpenApi(docV31(), docV30());

    expect(diff.breaking).toEqual([]);
    expect(diff.nonBreaking.map((e) => e.kind)).toEqual(['changed-openapi-version']);
    expect(diff.nonBreaking[0]?.message).toContain('3.1.0 → 3.0.3');
  });

  it('emits no version entry when both documents share a version', () => {
    const diff = diffOpenApi(docV30(), docV30());

    expect(diff.breaking).toEqual([]);
    expect(diff.nonBreaking).toEqual([]);
  });

  it('does not read 3.1 type arrays as a response type change', () => {
    const prev = docV30();
    const next = docV31();
    const diff = diffOpenApi(prev, next);

    expect(diff.breaking.some((e) => e.kind === 'changed-response-type')).toBe(false);
  });

  it('treats a one-member enum and const as the same permitted value', () => {
    const diff = diffOpenApi(docV30(), docV31());

    expect([...diff.breaking, ...diff.nonBreaking].some((e) => e.message.includes('settled'))).toBe(
      false,
    );
  });

  it('still detects a real breaking change made in the same commit as the version bump', () => {
    const prev = docV30();
    const next = docV31();
    const data = (
      (
        (next.paths['/refunds/{refundId}'].get as Record<string, unknown>).responses as Record<
          string,
          { content: { 'application/json': { schema: { allOf: Record<string, unknown>[] } } } }
        >
      )['200'].content['application/json'].schema.allOf[1] as {
        properties: { data: { properties: Record<string, unknown> } };
      }
    ).properties.data.properties;
    delete data.note;

    const diff = diffOpenApi(prev, next);

    expect(diff.breaking.map((e) => e.kind)).toContain('removed-response-field');
    expect(diff.nonBreaking.map((e) => e.kind)).toContain('changed-openapi-version');
  });

  it('detects a nullable field that lost a member type across dialects', () => {
    const prev = docV30();
    const next = docV31();
    const noteSchema = (
      (
        (next.paths['/refunds/{refundId}'].get as Record<string, unknown>).responses as Record<
          string,
          { content: { 'application/json': { schema: { allOf: Record<string, unknown>[] } } } }
        >
      )['200'].content['application/json'].schema.allOf[1] as {
        properties: { data: { properties: Record<string, Record<string, unknown>> } };
      }
    ).properties.data.properties.note;
    noteSchema.type = ['number', 'null'];

    const diff = diffOpenApi(prev, next);

    expect(diff.breaking.some((e) => e.kind === 'changed-response-type')).toBe(true);
  });
});

describe('diffOpenApi on 3.1-shaped documents', () => {
  it('does not crash when a document omits paths (3.1 allows webhooks-only documents)', () => {
    // `paths` is required in 3.0 and optional in 3.1, so the runtime shape is wider than the type.
    const webhooksOnly = {
      openapi: '3.1.0',
      info: { title: 'partner-api', version: '1.0.0' },
      webhooks: { refundSettled: { post: { operationId: 'refundSettled' } } },
    } as unknown as OpenApiDocument;

    const diff = diffOpenApi(webhooksOnly, webhooksOnly);

    expect(diff.breaking).toEqual([]);
    expect(diff.nonBreaking).toEqual([]);
  });

  it('reports operations removed by dropping paths entirely rather than throwing', () => {
    const next = {
      openapi: '3.0.3',
      info: { title: 'partner-api', version: '1.0.0' },
    } as unknown as OpenApiDocument;

    const diff = diffOpenApi(docV30(), next);

    expect(diff.breaking.map((e) => e.kind)).toEqual(['removed-operation']);
  });

  it('ignores path-item metadata keys when collecting operations', () => {
    const prev = docV30();
    prev.paths['/refunds/{refundId}'].summary = 'Refund by id';
    prev.paths['/refunds/{refundId}'].parameters = [
      { name: 'refundId', in: 'path', required: true, schema: { type: 'string' } },
    ];

    // Moving the shared parameter down into the operation is not an operation removal.
    const next = docV30();
    (next.paths['/refunds/{refundId}'].get as Record<string, unknown>).parameters = [
      { name: 'refundId', in: 'path', required: true, schema: { type: 'string' } },
    ];

    const diff = diffOpenApi(prev, next);

    expect(diff.breaking).toEqual([]);
    expect(diff.nonBreaking.some((e) => e.kind === 'added-operation')).toBe(false);
  });
});
