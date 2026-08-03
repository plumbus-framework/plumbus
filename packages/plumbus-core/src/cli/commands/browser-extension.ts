// ── plumbus browser-extension ──
// Scaffold a wxt Chrome/Firefox extension wired to Plumbus capabilities.

import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FlowDefinition } from '../../types/flow.js';
import { discoverResources } from '../discover.js';
import { type GeneratedFile, writeGeneratedFiles, writeScaffoldFiles } from '../scaffold-write.js';
import { findGitRoot, info, resolvePath, success, warn } from '../utils.js';

interface FlowTriggerInput {
  name: string;
  domain: string;
  description: string | undefined;
}

interface UiGeneratorModule {
  generateClientModule: (
    capabilities: import('../../types/capability.js').CapabilityContract[],
    flows: FlowTriggerInput[],
    config?: { baseUrl?: string; authModuleImport?: string },
  ) => string;
  capabilityClientFnName: (cap: { name: string }) => string;
  flowTriggerFnName: (flow: FlowTriggerInput) => string;
}

interface SampleCapabilitySelection {
  mode: 'zero-input' | 'none';
  capability?: import('../../types/capability.js').CapabilityContract;
}

interface BrowserExtensionGeneratorModule {
  assertValidAppName: (appName: string) => void;
  assertValidClientExportName: (exportName: string, sourceLabel: string) => void;
  generateBrowserExtensionScaffold: (input: {
    config: {
      appName: string;
      apiBaseUrl: string;
      browsers?: ('chrome' | 'firefox')[];
      auth?: boolean;
      registryEntries: Array<{ messageKey: string; exportName: string }>;
      sampleMessageKey?: string;
    };
    capabilities: import('../../types/capability.js').CapabilityContract[];
    flows: FlowTriggerInput[];
  }) => GeneratedFile[];
  selectSampleCapability: (
    capabilities: import('../../types/capability.js').CapabilityContract[],
  ) => SampleCapabilitySelection;
}

export interface BrowserExtensionScaffoldOptions {
  appName?: string;
  apiBaseUrl: string;
  browser?: string;
  force?: boolean;
  json?: boolean;
}

function toFlowTriggers(flows: FlowDefinition[]): FlowTriggerInput[] {
  return flows.map((flow) => ({
    name: flow.name,
    domain: flow.domain,
    description: flow.description,
  }));
}

function parseBrowsers(value: string | undefined): ('chrome' | 'firefox')[] {
  const v = value ?? 'both';
  if (v === 'chrome') return ['chrome'];
  if (v === 'firefox') return ['firefox'];
  if (v === 'both') return ['chrome', 'firefox'];
  throw new Error(`Invalid --browser "${v}". Use chrome, firefox, or both.`);
}

function validateApiBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid --api-base-url "${url}". Must be an absolute http(s) URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`--api-base-url must use http: or https: (got ${parsed.protocol}).`);
  }
  const bad = ['chrome-extension:', 'moz-extension:', 'file:'];
  if (bad.includes(parsed.protocol)) {
    throw new Error(`--api-base-url must not use ${parsed.protocol}`);
  }
}

function normalizeApiBaseUrl(url: string): string {
  validateApiBaseUrl(url);
  return url.replace(/\/+$/, '');
}

function inferAppName(cwd: string): string | undefined {
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (typeof pkg.name === 'string' && pkg.name.length > 0) {
          return pkg.name.replace(/^@[^/]+\//, '');
        }
      } catch {
        // continue
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function resolveRepoRootFromOutput(outputDir: string): string | null {
  const gitRoot = findGitRoot(path.resolve(outputDir));
  return gitRoot;
}

async function loadUiGenerators(): Promise<UiGeneratorModule> {
  const resolvedPath = path.join(
    process.cwd(),
    'node_modules',
    '@plumbus',
    'ui',
    'dist',
    'index.js',
  );
  if (!fs.existsSync(resolvedPath)) {
    throw new Error('missing-ui');
  }
  return (await import(pathToFileURL(resolvedPath).href)) as UiGeneratorModule;
}

async function loadBrowserExtensionGenerators(): Promise<BrowserExtensionGeneratorModule> {
  const resolvedPath = path.join(
    process.cwd(),
    'node_modules',
    '@plumbus',
    'browser-extension',
    'dist',
    'index.js',
  );
  if (!fs.existsSync(resolvedPath)) {
    throw new Error('missing-browser-extension');
  }
  return (await import(pathToFileURL(resolvedPath).href)) as BrowserExtensionGeneratorModule;
}

async function loadScaffoldDeps(): Promise<{
  ui: UiGeneratorModule;
  browserExtension: BrowserExtensionGeneratorModule;
}> {
  try {
    const ui = await loadUiGenerators();
    const browserExtension = await loadBrowserExtensionGenerators();
    return { ui, browserExtension };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (reason === 'missing-ui' || reason === 'missing-browser-extension') {
      console.error('');
      console.error('Browser extension scaffolder dependencies are not installed.');
      console.error('Run: pnpm add @plumbus/ui @plumbus/browser-extension');
      console.error('');
      process.exit(1);
    }
    throw err;
  }
}

const CLIENT_HEADER = `// Generated by plumbus browser-extension scaffold.
// Do not edit manually. Re-run the scaffold command after capability changes.

`;

export function registerBrowserExtensionCommand(program: Command): void {
  const browserExtension = program
    .command('browser-extension')
    .description('Scaffold a wxt browser extension wired to Plumbus capabilities');

  browserExtension
    .command('scaffold [output-dir]')
    .description('Generate a Chrome/Firefox extension project')
    .option('--app-name <name>', 'Application name for the generated extension')
    .option('--api-base-url <url>', 'Absolute API base URL (required)', '')
    .option('--browser <target>', 'chrome | firefox | both', 'both')
    .option('--force', 'Overwrite existing scaffold files')
    .option('--json', 'Emit machine-readable result JSON')
    .action(async (outputDir: string | undefined, opts: BrowserExtensionScaffoldOptions) => {
      if (!opts.apiBaseUrl) {
        console.error('--api-base-url is required');
        process.exit(1);
      }

      let apiBaseUrl: string;
      try {
        apiBaseUrl = normalizeApiBaseUrl(opts.apiBaseUrl);
        parseBrowsers(opts.browser);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const outputRoot = resolvePath(outputDir ?? 'extension');
      const repoRoot = resolveRepoRootFromOutput(outputRoot);
      if (repoRoot && path.resolve(outputRoot) === path.resolve(repoRoot) && !opts.force) {
        console.error(
          'Refusing to scaffold into repository root. Pass a subdirectory or use --force.',
        );
        process.exit(1);
      }

      let appName = opts.appName;
      if (!appName) {
        appName = inferAppName(process.cwd());
        if (appName && !opts.json) {
          info(`Inferred --app-name ${appName}`);
        }
      }
      if (!appName) {
        console.error('--app-name is required (could not infer from package.json)');
        process.exit(1);
      }

      const { ui, browserExtension } = await loadScaffoldDeps();

      try {
        browserExtension.assertValidAppName(appName);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      if (!opts.json) {
        info('Discovering capabilities and flows...');
      }
      const resources = await discoverResources();
      const flows = toFlowTriggers(resources.flows);
      const browsers = parseBrowsers(opts.browser);

      const registryEntries = [
        ...resources.capabilities.map((cap) => {
          const exportName = ui.capabilityClientFnName(cap);
          browserExtension.assertValidClientExportName(exportName, `capability "${cap.name}"`);
          return { messageKey: exportName, exportName };
        }),
        ...flows.map((flow) => {
          const exportName = ui.flowTriggerFnName(flow);
          browserExtension.assertValidClientExportName(exportName, `flow "${flow.name}"`);
          return { messageKey: exportName, exportName };
        }),
      ];

      const sampleSel = browserExtension.selectSampleCapability(resources.capabilities);
      const sampleMessageKey =
        sampleSel.mode === 'zero-input' && sampleSel.capability
          ? ui.capabilityClientFnName(sampleSel.capability)
          : undefined;

      // The scaffold's tsconfig uses node16 resolution, which requires explicit
      // file extensions on relative imports.
      const clientContent =
        CLIENT_HEADER +
        ui.generateClientModule(resources.capabilities, flows, {
          baseUrl: apiBaseUrl,
          authModuleImport: './auth.js',
        });

      const shellFiles = browserExtension.generateBrowserExtensionScaffold({
        config: {
          appName,
          apiBaseUrl,
          browsers,
          auth: true,
          registryEntries,
          sampleMessageKey,
        },
        capabilities: resources.capabilities,
        flows,
      });

      const clientFile: GeneratedFile = { path: 'src/client/api.ts', content: clientContent };

      const scaffoldResult = writeScaffoldFiles(outputRoot, shellFiles, opts.force);
      const clientWritten = writeGeneratedFiles(outputRoot, [clientFile]);

      const plumbusCache = resolvePath('.plumbus/generated/browser-extension');
      if (path.resolve(plumbusCache) !== path.resolve(outputRoot)) {
        writeGeneratedFiles(plumbusCache, [clientFile]);
      }

      const warnings: string[] = [];
      if (scaffoldResult.skipped.length > 0) {
        warnings.push(`${scaffoldResult.skipped.length} scaffold file(s) skipped (already exist)`);
      }
      if (opts.force && scaffoldResult.overwritten.length > 0) {
        warnings.push('Existing scaffold files were overwritten — local edits may be lost');
      }

      const result = {
        outputDir: outputRoot,
        written: [...scaffoldResult.written, ...clientWritten],
        skipped: scaffoldResult.skipped,
        overwritten: scaffoldResult.overwritten,
        generatedClient: 'src/client/api.ts',
        warnings,
      };

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const file of scaffoldResult.written) {
        success(`Generated ${path.relative(process.cwd(), file)}`);
      }
      for (const file of clientWritten) {
        success(`Generated ${path.relative(process.cwd(), file)}`);
      }
      for (const file of scaffoldResult.skipped) {
        warn(`Skipped (exists): ${path.relative(process.cwd(), file)}`);
      }
      if (opts.force && scaffoldResult.overwritten.length > 0) {
        warn('Used --force: existing scaffold files may have been overwritten.');
      }
    });
}
