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
}

interface ApiDiffEntry {
  kind: string;
  message: string;
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
    .action(async (opts: { manifest?: string; json?: boolean }) => {
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

      if (allFindings.length > 0 || govSignals.length > 0) {
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
