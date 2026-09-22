export interface OpenApiDocument {
  openapi: string;
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
