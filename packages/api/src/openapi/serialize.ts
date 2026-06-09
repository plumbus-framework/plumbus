import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { OpenApiDocument } from './types.js';

export function serializeOpenApiDocument(doc: OpenApiDocument, format: 'json' | 'yaml'): string {
  if (format === 'yaml') {
    return yamlStringify(doc);
  }
  return JSON.stringify(doc, null, 2);
}

/** Parse an OpenAPI document from JSON or YAML source text. */
export function parseOpenApiDocument(source: string, filePath?: string): OpenApiDocument {
  const ext = filePath?.toLowerCase() ?? '';
  if (ext.endsWith('.yaml') || ext.endsWith('.yml')) {
    return yamlParse(source) as OpenApiDocument;
  }
  try {
    return JSON.parse(source) as OpenApiDocument;
  } catch {
    return yamlParse(source) as OpenApiDocument;
  }
}
