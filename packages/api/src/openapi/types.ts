export interface OpenApiDocument {
  openapi: string;
  /** OpenAPI 3.1 only: the JSON Schema dialect every Schema Object is written in. */
  jsonSchemaDialect?: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
  security?: Record<string, string[]>[];
}

export interface DiffEntry {
  kind: string;
  message: string;
  path?: string;
  operationId?: string;
}
