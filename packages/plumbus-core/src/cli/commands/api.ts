// ── plumbus api ──
// External API contract validation, OpenAPI/docs generation, and compatibility diff.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Command } from 'commander';
import { apiRules } from '../../governance/rules/api.js';
import { createGovernanceRuleEngine } from '../../governance/rule-engine.js';
import type { CapabilityContract } from '../../types/capability.js';
import { ApiManifestLoadError, resolveApiManifest } from './api-manifest.js';
import { discoverResources } from '../discover.js';
import { info, resolvePath, success, warn, writeFile } from '../utils.js';

interface ApiFinding {
  code: string;
  message: string;
}

interface ApiDiffEntry {
  kind: string;
  message: string;
}

interface GovernanceSignal {
  rule: string;
  description: string;
}

/**
 * OpenAPI document versions `plumbus api generate openapi` can emit.
 *
 * Mirrors `OPENAPI_VERSIONS` in `@plumbus/api`, which the CLI cannot import: the package is an
 * optional peer loaded through a dynamic import, and the flag has to be validated before the
 * runtime is resolved so a typo fails with a usage error instead of an install hint.
 */
export const OPENAPI_DOCUMENT_VERSIONS = ['3.0.3', '3.1.0'] as const;

export type OpenApiDocumentVersion = (typeof OPENAPI_DOCUMENT_VERSIONS)[number];

/** Default document version. 3.0.3 stays the default so published baselines do not move on
 *  upgrade; 3.1.0 is opt-in via `--openapi-version`. */
export const DEFAULT_OPENAPI_DOCUMENT_VERSION: OpenApiDocumentVersion = '3.0.3';

/**
 * Validate the `--openapi-version` flag value (testable without process.exit).
 * Returns the accepted version, or a message naming the accepted values.
 */
export function resolveOpenApiDocumentVersion(
  raw: string | undefined,
): { version: OpenApiDocumentVersion } | { error: string } {
  if (raw === undefined) {
    return { version: DEFAULT_OPENAPI_DOCUMENT_VERSION };
  }
  const match = OPENAPI_DOCUMENT_VERSIONS.find((v) => v === raw);
  if (!match) {
    return {
      error: `Unsupported OpenAPI version "${raw}". Supported: ${OPENAPI_DOCUMENT_VERSIONS.join(', ')}.`,
    };
  }
  return { version: match };
}

/** Pure exit-code policy for `plumbus api validate` (testable without process.exit). */
export function apiValidateShouldFail(
  hardFindings: readonly unknown[],
  governanceSignals: readonly GovernanceSignal[],
  opts: { failOnGovernance?: boolean },
): boolean {
  if (hardFindings.length > 0) return true;
  if (opts.failOnGovernance && governanceSignals.length > 0) return true;
  return false;
}

/** Local view of @plumbus/api runtime (optional peer — dynamic import only). */
interface ApiRuntimeModule {
  parseManifest: (source: string, format: 'yaml' | 'json') => unknown;
  buildDefaultManifest: (
    capabilities: import('../../types/capability.js').CapabilityContract[],
  ) => unknown;
  validateApiContract: (
    manifest: unknown,
    capabilities: import('../../types/capability.js').CapabilityContract[],
    appRoot: string,
  ) => Promise<{
    manifest: ApiFinding[];
    policy: ApiFinding[];
    pathParams: ApiFinding[];
    fixtures: ApiFinding[];
  }>;
  generateOpenApi: (
    capabilities: import('../../types/capability.js').CapabilityContract[],
    manifest: unknown,
    options?: { version?: OpenApiDocumentVersion },
  ) => unknown;
  serializeOpenApiDocument: (doc: unknown, format: 'json' | 'yaml') => string;
  parseOpenApiDocument: (source: string, filePath?: string) => unknown;
  generateApiDocs: (
    capabilities: import('../../types/capability.js').CapabilityContract[],
    manifest: unknown,
  ) => Map<string, string>;
  diffOpenApi: (
    prev: unknown,
    next: unknown,
  ) => {
    breaking: ApiDiffEntry[];
    nonBreaking: ApiDiffEntry[];
  };
  validateTestFixtures: (
    capabilities: import('../../types/capability.js').CapabilityContract[],
    appRoot: string,
    manifest?: unknown,
  ) => Promise<ApiFinding[]>;
}

/**
 * Generate the partner OpenAPI document at the requested document version.
 *
 * The generator owns the `openapi` field; the CLI never rewrites it, because a version string
 * without the matching schema dialect would be a mislabelled document. An `@plumbus/api` older
 * than 3.1 support ignores the option and returns 3.0.3 — that mismatch is reported instead of
 * writing a file whose contents contradict what was asked for.
 */
export function generateOpenApiAtVersion(
  api: Pick<ApiRuntimeModule, 'generateOpenApi'>,
  capabilities: CapabilityContract[],
  manifest: unknown,
  version: OpenApiDocumentVersion,
): { doc: unknown } | { error: string } {
  const doc = api.generateOpenApi(capabilities, manifest, { version });
  const emitted = (doc as { openapi?: unknown } | null | undefined)?.openapi;
  if (typeof emitted === 'string' && emitted !== version) {
    return {
      error:
        `Requested OpenAPI ${version}, but the installed @plumbus/api emitted ${emitted}. ` +
        `Upgrade @plumbus/api to a release that supports OpenAPI ${version} emission.`,
    };
  }
  return { doc };
}

async function loadApiRuntime(): Promise<ApiRuntimeModule> {
  try {
    const mod = '@plumbus/api';
    return (await import(mod)) as ApiRuntimeModule;
  } catch {
    console.error('');
    console.error('API runtime not installed.');
    console.error('Run: pnpm add @plumbus/api');
    console.error('');
    process.exit(1);
  }
}

async function loadManifestAndCaps(manifestPath?: string) {
  const api = await loadApiRuntime();
  const resources = await discoverResources();
  const capabilities = resources.capabilities;

  const file = manifestPath ?? resolvePath('api.yaml');
  let manifest: unknown;
  try {
    const loaded = await resolveApiManifest({
      filePath: file,
      explicitManifest: manifestPath !== undefined,
      capabilities,
      api,
    });
    manifest = loaded.manifest;
    if (loaded.warning) {
      warn(loaded.warning);
    }
  } catch (err) {
    if (err instanceof ApiManifestLoadError) {
      console.error('');
      console.error(err.message);
      console.error('');
      process.exit(1);
    }
    throw err;
  }

  return { api, manifest, capabilities, appRoot: process.cwd() };
}

export function registerApiCommand(program: Command): void {
  const apiCmd = program
    .command('api')
    .description('External API contract — validate, generate OpenAPI/docs, diff');

  apiCmd
    .command('validate')
    .description('Validate API manifest, policy, path params, fixtures, and governance')
    .option('--manifest <path>', 'Path to API manifest (default: ./api.yaml)')
    .option('--json', 'Output results as JSON')
    .option(
      '--fail-on-governance',
      'Exit with failure when advisory governance signals are present (default: advisory only)',
    )
    .action(async (opts: { manifest?: string; json?: boolean; failOnGovernance?: boolean }) => {
      const { api, manifest, capabilities, appRoot } = await loadManifestAndCaps(opts.manifest);
      const result = await api.validateApiContract(manifest, capabilities, appRoot);

      const engine = createGovernanceRuleEngine();
      engine.registerMany(apiRules);
      const gov = engine.evaluate({
        capabilities,
        entities: [],
        flows: [],
        events: [],
        prompts: [],
      });

      const allFindings = [
        ...result.manifest,
        ...result.policy,
        ...result.pathParams,
        ...result.fixtures,
      ];
      const govSignals = gov.effective;

      if (opts.json) {
        console.log(JSON.stringify({ ...result, governance: govSignals }, null, 2));
      } else {
        for (const f of allFindings) {
          warn(`[${f.code}] ${f.message}`);
        }
        for (const s of govSignals) {
          warn(`[${s.rule}] ${s.description}`);
        }
      }

      if (
        apiValidateShouldFail(allFindings, govSignals, { failOnGovernance: opts.failOnGovernance })
      ) {
        process.exit(1);
      }
      success('API contract validation passed');
    });

  const generate = apiCmd.command('generate').description('Generate API artifacts');

  generate
    .command('openapi')
    .description('Generate OpenAPI specification')
    .requiredOption('--out <file>', 'Output file path')
    .option('--format <format>', 'json or yaml', 'json')
    .option(
      '--openapi-version <version>',
      `OpenAPI document version to emit (${OPENAPI_DOCUMENT_VERSIONS.join(' or ')})`,
      DEFAULT_OPENAPI_DOCUMENT_VERSION,
    )
    .option('--manifest <path>', 'Path to API manifest')
    .action(
      async (opts: {
        out: string;
        format?: string;
        openapiVersion?: string;
        manifest?: string;
      }) => {
        const resolvedVersion = resolveOpenApiDocumentVersion(opts.openapiVersion);
        if ('error' in resolvedVersion) {
          console.error('');
          console.error(resolvedVersion.error);
          console.error('');
          process.exit(1);
        }

        const { api, manifest, capabilities } = await loadManifestAndCaps(opts.manifest);
        const generated = generateOpenApiAtVersion(
          api,
          capabilities,
          manifest,
          resolvedVersion.version,
        );
        if ('error' in generated) {
          console.error('');
          console.error(generated.error);
          console.error('');
          process.exit(1);
        }

        const outPath = resolvePath(opts.out);
        const format = opts.format === 'yaml' ? 'yaml' : 'json';
        const content = api.serializeOpenApiDocument(generated.doc, format);
        writeFile(outPath, content);
        success(`Wrote OpenAPI ${resolvedVersion.version} spec to ${outPath}`);
      },
    );

  generate
    .command('docs')
    .description('Generate Markdown API documentation')
    .requiredOption('--out <dir>', 'Output directory')
    .option('--manifest <path>', 'Path to API manifest')
    .action(async (opts: { out: string; manifest?: string }) => {
      const { api, manifest, capabilities } = await loadManifestAndCaps(opts.manifest);
      const files = api.generateApiDocs(capabilities, manifest);
      const outDir = resolvePath(opts.out);
      for (const [rel, content] of files) {
        writeFile(path.join(outDir, rel), content);
      }
      success(`Wrote ${files.size} doc file(s) to ${outDir}`);
    });

  apiCmd
    .command('diff')
    .description('Compare current OpenAPI against a published spec')
    .requiredOption('--against <file>', 'Previously published OpenAPI file')
    .option(
      '--openapi-version <version>',
      `OpenAPI document version to generate the current spec at (${OPENAPI_DOCUMENT_VERSIONS.join(' or ')})`,
      DEFAULT_OPENAPI_DOCUMENT_VERSION,
    )
    .option('--manifest <path>', 'Path to API manifest')
    .option('--json', 'Output as JSON')
    .action(
      async (opts: {
        against: string;
        openapiVersion?: string;
        manifest?: string;
        json?: boolean;
      }) => {
        const resolvedVersion = resolveOpenApiDocumentVersion(opts.openapiVersion);
        if ('error' in resolvedVersion) {
          console.error('');
          console.error(resolvedVersion.error);
          console.error('');
          process.exit(1);
        }

        const { api, manifest, capabilities } = await loadManifestAndCaps(opts.manifest);
        const generated = generateOpenApiAtVersion(
          api,
          capabilities,
          manifest,
          resolvedVersion.version,
        );
        if ('error' in generated) {
          console.error('');
          console.error(generated.error);
          console.error('');
          process.exit(1);
        }
        const current = generated.doc;
        const againstPath = resolvePath(opts.against);
        const prevRaw = await readFile(againstPath, 'utf8');
        const prev = api.parseOpenApiDocument(prevRaw, againstPath);
        const diff = api.diffOpenApi(prev, current);

        if (opts.json) {
          console.log(JSON.stringify(diff, null, 2));
        } else {
          for (const b of diff.breaking) {
            warn(`[BREAKING] ${b.message}`);
          }
          for (const nb of diff.nonBreaking) {
            info(`[non-breaking] ${nb.message}`);
          }
        }

        if (diff.breaking.length > 0) {
          process.exit(1);
        }
        success('No breaking API changes detected');
      },
    );

  const testFixtures = apiCmd
    .command('test-fixtures')
    .description('Validate API test fixtures against capability schemas');

  testFixtures
    .command('validate')
    .description('Validate fixture files')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const { api, manifest, capabilities, appRoot } = await loadManifestAndCaps();
      const findings = await api.validateTestFixtures(capabilities, appRoot, manifest);

      if (opts.json) {
        console.log(JSON.stringify({ findings }, null, 2));
      } else {
        for (const f of findings) {
          warn(`[${f.code}] ${f.message}`);
        }
      }

      if (findings.length > 0) {
        process.exit(1);
      }
      success('All test fixtures are valid');
    });
}
