import { ApiManifestError } from '../errors.js';

/**
 * OpenAPI document versions this generator can emit.
 *
 * `3.0.3` is the historical output and stays the default: every published
 * consumer of `generateOpenApi` receives byte-identical documents unless it
 * asks for something else. `3.1.0` is opt-in.
 */
export const OPENAPI_VERSIONS = ['3.0.3', '3.1.0'] as const;

export type OpenApiVersion = (typeof OPENAPI_VERSIONS)[number];

/** Version emitted when the caller does not request one. */
export const DEFAULT_OPENAPI_VERSION: OpenApiVersion = '3.0.3';

/**
 * The JSON Schema dialect OpenAPI 3.1 Schema Objects are written in, declared
 * at the document root through `jsonSchemaDialect`. 3.1 fixes this as the
 * default dialect; stating it makes the document self-describing for tooling
 * that resolves schemas outside an OpenAPI context.
 */
export const JSON_SCHEMA_2020_12_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

export interface GenerateOpenApiOptions {
  /** OpenAPI document version to emit. Defaults to {@link DEFAULT_OPENAPI_VERSION}. */
  version?: OpenApiVersion;
}

function isSupportedVersion(version: string): version is OpenApiVersion {
  return (OPENAPI_VERSIONS as readonly string[]).includes(version);
}

/**
 * Normalise a requested document version, defaulting when absent and failing
 * loudly on anything this generator cannot honour. Silently downgrading an
 * unknown version would produce a document that claims one contract and obeys
 * another.
 */
export function resolveOpenApiVersion(version: string | undefined): OpenApiVersion {
  if (version === undefined) {
    return DEFAULT_OPENAPI_VERSION;
  }
  if (isSupportedVersion(version)) {
    return version;
  }
  throw new ApiManifestError(
    `Unsupported OpenAPI version "${version}"; expected one of ${OPENAPI_VERSIONS.join(', ')}`,
    'api.openapi.unsupported_version',
  );
}
