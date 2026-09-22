import { describe, expect, it } from 'vitest';
import { parseOpenApiDocument, serializeOpenApiDocument } from '../serialize.js';
import type { OpenApiDocument } from '../types.js';

const minimalDoc = (): OpenApiDocument => ({
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  paths: {},
});

describe('serializeOpenApiDocument', () => {
  it('serializes json', () => {
    const content = serializeOpenApiDocument(minimalDoc(), 'json');
    expect(JSON.parse(content)).toEqual(minimalDoc());
  });

  it('serializes yaml', () => {
    const content = serializeOpenApiDocument(minimalDoc(), 'yaml');
    expect(content).toContain('openapi: 3.0.3');
    expect(content).not.toMatch(/^\{/);
  });

  it('parses yaml OpenAPI documents', () => {
    const yaml = serializeOpenApiDocument(minimalDoc(), 'yaml');
    const parsed = parseOpenApiDocument(yaml, 'spec.yaml');
    expect(parsed.openapi).toBe('3.0.3');
  });

  it('parses json OpenAPI documents', () => {
    const json = serializeOpenApiDocument(minimalDoc(), 'json');
    const parsed = parseOpenApiDocument(json, 'spec.json');
    expect(parsed.info.title).toBe('t');
  });
});
