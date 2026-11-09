// ── plumbus api ──
// External API contract validation, OpenAPI/docs generation, and compatibility diff.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Command } from 'commander';
import { apiRules } from '../../governance/rules/api.js';
import { createGovernanceRuleEngine } from '../../governance/rule-engine.js';
import { ApiManifestLoadError, resolveApiManifest } from './api-manifest.js';
import { discoverResources } from '../discover.js';
import { info, resolvePath, success, warn, writeFile } from '../utils.js';

interface ApiFinding {
  code: string;
  message: string;
  severity?: 'error' | 'warning';
}

interface ApiDiffEntry {
  kind: string;
  message: string;
}

interface GovernanceSignal {
  rule: string;
  description: string;
}

/** Security findings that count as errors (warning-only findings never fail the command). */
export function blockingSecurityFindings(
  securityFindings: readonly ApiFinding[],
): readonly ApiFinding[] {
  return securityFindings.filter((finding) => finding.severity !== 'warning');
}

/**
 * Pure exit-code policy for `plumbus api validate` (testable without process.exit).
 *
 * Security findings fail the command only with `failOnSecurity` (`--fail-on-security`) in 0.8.x,
 * and then only those that are not `severity: 'warning'`.
 */
export function apiValidateShouldFail(
  hardFindings: readonly unknown[],
  governanceSignals: readonly GovernanceSignal[],
  opts: { failOnGovernance?: boolean; failOnSecurity?: boolean },
  securityFindings: readonly ApiFinding[] = [],
): boolean {
  if (hardFindings.length > 0) return true;
  if (opts.failOnGovernance && governanceSignals.length > 0) return true;
  if (opts.failOnSecurity && blockingSecurityFindings(securityFindings).length > 0) return true;
  return false;
}

/** Line printed when security findings exist but do not affect the exit code. */
export const API_VALIDATE_SECURITY_ADVISORY_NOTICE =
  'Security findings do not fail `plumbus api validate` in 0.8 — pass --fail-on-security to exit 1 on them.';

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
    /** Present in @plumbus/api releases that validate `security` config. */
    security?: ApiFinding[];
    fixtures: ApiFinding[];
    ok?: boolean;
  }>;
  generateOpenApi: (
    capabilities: import('../../types/capability.js').CapabilityContract[],
    manifest: unknown,
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
    .option(
      '--fail-on-security',
      'Exit with failure when API security findings of error severity are present (default: reported only)',
    )
    .action(
      async (opts: {
        manifest?: string;
        json?: boolean;
        failOnGovernance?: boolean;
        failOnSecurity?: boolean;
      }) => {
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
        const securityFindings = result.security ?? [];
        const securityNoticeNeeded =
          !opts.failOnSecurity && blockingSecurityFindings(securityFindings).length > 0;

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                ...result,
                security: securityFindings,
                governance: govSignals,
                securityFailsCommand: opts.failOnSecurity === true,
              },
              null,
              2,
            ),
          );
          // stderr keeps stdout parseable JSON.
          if (securityNoticeNeeded) console.error(API_VALIDATE_SECURITY_ADVISORY_NOTICE);
        } else {
          for (const f of allFindings) {
            warn(`[${f.code}] ${f.message}`);
          }
          for (const f of securityFindings) {
            warn(`[${f.code}]${f.severity === 'warning' ? ' (warning)' : ''} ${f.message}`);
          }
          for (const s of govSignals) {
            warn(`[${s.rule}] ${s.description}`);
          }
          if (securityNoticeNeeded) {
            info(API_VALIDATE_SECURITY_ADVISORY_NOTICE);
          }
        }

        if (
          apiValidateShouldFail(
            allFindings,
            govSignals,
            { failOnGovernance: opts.failOnGovernance, failOnSecurity: opts.failOnSecurity },
            securityFindings,
          )
        ) {
          process.exit(1);
        }
        success('API contract validation passed');
      },
    );

  const generate = apiCmd.command('generate').description('Generate API artifacts');

  generate
    .command('openapi')
    .description('Generate OpenAPI specification')
    .requiredOption('--out <file>', 'Output file path')
    .option('--format <format>', 'json or yaml', 'json')
    .option('--manifest <path>', 'Path to API manifest')
    .action(async (opts: { out: string; format?: string; manifest?: string }) => {
      const { api, manifest, capabilities } = await loadManifestAndCaps(opts.manifest);
      const doc = api.generateOpenApi(capabilities, manifest);
      const outPath = resolvePath(opts.out);
      const format = opts.format === 'yaml' ? 'yaml' : 'json';
      const content = api.serializeOpenApiDocument(doc, format);
      writeFile(outPath, content);
      success(`Wrote OpenAPI spec to ${outPath}`);
    });

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
    .option('--manifest <path>', 'Path to API manifest')
    .option('--json', 'Output as JSON')
    .action(async (opts: { against: string; manifest?: string; json?: boolean }) => {
      const { api, manifest, capabilities } = await loadManifestAndCaps(opts.manifest);
      const current = api.generateOpenApi(capabilities, manifest);
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
    });

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
