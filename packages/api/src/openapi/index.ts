export { generateOpenApi } from './generate.js';
export { toJsonSchema2020, toOpenApi31Document } from './openapi-3-1.js';
export { parseOpenApiDocument, serializeOpenApiDocument } from './serialize.js';
export type { DiffEntry, OpenApiDocument } from './types.js';
export {
  DEFAULT_OPENAPI_VERSION,
  type GenerateOpenApiOptions,
  JSON_SCHEMA_2020_12_DIALECT,
  OPENAPI_VERSIONS,
  type OpenApiVersion,
  resolveOpenApiVersion,
} from './version.js';
export { zodToOpenApiSchema } from './zod-to-openapi-schema.js';
