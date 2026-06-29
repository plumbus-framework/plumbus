// ── plumbus ui ──
// Generate frontend-facing source files and scaffolds via @plumbus/ui.

import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type E2EActionDescriptor,
  type E2EPageDescriptor,
  type E2EQueryDescriptor,
  generateE2ETest,
} from '../../testing/scaffolding.js';
import type { CapabilityContract } from '../../types/capability.js';
import type { FlowDefinition } from '../../types/flow.js';
import type { TranslationDefinition } from '../../types/translation.js';
import { discoverResources } from '../discover.js';
import {
  detectMonorepoLayout,
  info,
  migrateUiLegacyStructure,
  resolvePath,
  success,
  warn,
  writeFile,
} from '../utils.js';

// ── Types for dynamically loaded @plumbus/ui ──

interface FlowTriggerInput {
  name: string;
  domain: string;
  description: string | undefined;
}

interface ClientGeneratorConfig {
  baseUrl?: string;
  includeJsDoc?: boolean;
}

interface AuthHelperConfig {
  provider?: string;
  tokenKey?: string;
  multiTenant?: boolean;
}

interface NextjsTemplateConfig {
  appName: string;
  auth?: boolean;
  apiBaseUrl?: string;
}

interface GeneratedFile {
  path: string;
  content: string;
}

interface GeneratedTranslationFile {
  path: string;
  content: string;
}

interface UiGenerateOptions {
  outDir?: string;
  baseUrl?: string;
  authProvider?: string;
  tokenKey?: string;
  multiTenant?: boolean;
  includeJsDoc?: boolean;
  splitLocaleBundles?: boolean;
  json?: boolean;
}

interface UiNextjsOptions extends UiGenerateOptions {
  appName?: string;
  apiBaseUrl?: string;
  auth?: boolean;
  force?: boolean;
}

export interface UiGeneratorModule {
  generateClientModule(
    capabilities: CapabilityContract[],
    flows: FlowTriggerInput[],
    config?: ClientGeneratorConfig,
  ): string;
  generateHooksModule(capabilities: CapabilityContract[], config?: ClientGeneratorConfig): string;
  generateAuthModule(config?: AuthHelperConfig): string;
  generateFormHintsModule(capabilities: CapabilityContract[]): string;
  generateTranslationModule?(
    definitions: TranslationDefinition[],
    options?: { splitLocaleBundles?: boolean },
  ): GeneratedTranslationFile[];
  generateNextjsTemplate(
    config: NextjsTemplateConfig,
    capabilities?: CapabilityContract[],
  ): GeneratedFile[];
}

function toFlowTriggers(flows: FlowDefinition[]): FlowTriggerInput[] {
  return flows.map((flow) => ({
    name: flow.name,
    domain: flow.domain,
    description: flow.description,
  }));
}

// ── E2E Page Discovery ──

/**
 * Scan a Next.js frontend for page.tsx files that contain ActionPanel components.
 * Extracts route, panel titles, submit labels, and field names from the source.
 */
function discoverFrontendPages(frontendDir: string): E2EPageDescriptor[] {
  const appDir = path.join(frontendDir, 'app');
  if (!fs.existsSync(appDir)) return [];

  const pages: E2EPageDescriptor[] = [];
  scanPagesRecursive(appDir, '', pages);
  return pages;
}

function scanPagesRecursive(dir: string, routePrefix: string, out: E2EPageDescriptor[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'api') continue; // skip API routes
    if (entry.isDirectory()) {
      scanPagesRecursive(path.join(dir, entry.name), `${routePrefix}/${entry.name}`, out);
    }
    if (entry.name === 'page.tsx' || entry.name === 'page.ts') {
      const filePath = path.join(dir, entry.name);
      const source = fs.readFileSync(filePath, 'utf-8');
      const page = parsePageSource(source, routePrefix || '/');
      if (page) out.push(page);
    }
  }
}

function parsePageSource(source: string, route: string): E2EPageDescriptor | null {
  // Extract ActionPanel usages
  const actionPanelRegex = /<ActionPanel\s[\s\S]*?\/>/gs;
  const panels = [...source.matchAll(actionPanelRegex)];
  if (panels.length === 0) {
    // Page might still be worth testing if it has headings
    const hasH1 = /<h1[^>]*>/.test(source);
    if (!hasH1) return null;
  }

  const actions: E2EActionDescriptor[] = [];
  for (const match of panels) {
    const panelStr = match[0];
    const titleMatch = panelStr.match(/title="([^"]+)"/);
    const submitMatch = panelStr.match(/submitLabel="([^"]+)"/);
    const fieldsMatch = panelStr.match(/fields=\{(\w+)\}/);
    const title = titleMatch?.[1] ?? 'Unknown panel';
    const submitLabel = submitMatch?.[1] ?? 'Submit';

    // Try to extract field names from the fields array variable
    let fields: string[] = [];
    if (fieldsMatch) {
      const varName = fieldsMatch[1];
      // Find the const declaration for this fields array
      const varRegex = new RegExp(`const\\s+${varName}[^=]*=\\s*\\[([\\s\\S]*?)\\];`);
      const varMatch = source.match(varRegex);
      if (varMatch?.[1]) {
        const nameMatches = [...varMatch[1].matchAll(/name:\s*"([^"]+)"/g)];
        fields = nameMatches.map((m) => m[1] ?? '');
      }
    }

    actions.push({ title, submitLabel, fields });
  }

  // Detect query panels (NextTargetPanel, BudgetPanel, etc. — articles with status-card class)
  const queries: E2EQueryDescriptor[] = [];
  const queryHeadings = [...source.matchAll(/<h3>([^<]+)<\/h3>/g)];
  for (const h of queryHeadings) {
    if (h[1] && !actions.some((a) => a.title === h[1])) {
      queries.push({ title: h[1] });
    }
  }

  const pageName =
    route === '/'
      ? 'Home'
      : route
          .replace(/^\//, '')
          .replace(/\//g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());

  return { route, pageName, actions, queries };
}

export function generateE2EVitestConfig(baseUrl: string): string {
  return `export default {
  test: {
    include: ["**/*.e2e.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
};

// E2E_BASE_URL default: ${baseUrl}
`;
}

function nextEnvTypesFile(): GeneratedFile {
  return {
    path: 'next-env.d.ts',
    content: `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// This file is auto-generated by Next.js.
`,
  };
}

export function generateUiModuleFiles(
  capabilities: CapabilityContract[],
  flows: FlowDefinition[],
  generators: UiGeneratorModule,
  options: UiGenerateOptions,
  directoryPrefix = '',
  translations: TranslationDefinition[] = [],
): GeneratedFile[] {
  const prefix = directoryPrefix ? `${directoryPrefix}/` : '';
  const clientConfig = {
    baseUrl: options.baseUrl,
    includeJsDoc: options.includeJsDoc,
  } satisfies ClientGeneratorConfig;
  const authConfig = {
    provider: options.authProvider ?? 'jwt',
    tokenKey: options.tokenKey,
    multiTenant: options.multiTenant,
  } satisfies AuthHelperConfig;

  const files: GeneratedFile[] = [
    {
      path: `${prefix}lib/client.ts`,
      content: generators.generateClientModule(capabilities, toFlowTriggers(flows), clientConfig),
    },
    {
      path: `${prefix}hooks/hooks.ts`,
      content: generators.generateHooksModule(capabilities, clientConfig),
    },
    {
      path: `${prefix}lib/auth.ts`,
      content: generators.generateAuthModule(authConfig),
    },
    {
      path: `${prefix}lib/form-hints.ts`,
      content: generators.generateFormHintsModule(capabilities),
    },
  ];

  // Generate i18n modules if translations are available
  if (translations.length > 0 && generators.generateTranslationModule) {
    const i18nFiles = generators.generateTranslationModule(translations, {
      splitLocaleBundles: options.splitLocaleBundles,
    });
    for (const file of i18nFiles) {
      files.push({ path: `${prefix}${file.path}`, content: file.content });
    }
  }

  return files;
}

export function generateNextjsAppFiles(
  appName: string,
  capabilities: CapabilityContract[],
  flows: FlowDefinition[],
  generators: UiGeneratorModule,
  options: UiNextjsOptions,
  translations: TranslationDefinition[] = [],
): GeneratedFile[] {
  const templateFiles = generators.generateNextjsTemplate(
    {
      appName,
      auth: options.auth,
      apiBaseUrl: options.apiBaseUrl,
    },
    capabilities,
  );

  const moduleFiles = generateUiModuleFiles(
    capabilities,
    flows,
    generators,
    {
      ...options,
      baseUrl: options.baseUrl,
    },
    '',
    translations,
  );

  return [...templateFiles, nextEnvTypesFile(), ...moduleFiles];
}

async function loadUiGenerators(): Promise<UiGeneratorModule> {
  try {
    const resolvedPath = path.join(
      process.cwd(),
      'node_modules',
      '@plumbus',
      'ui',
      'dist',
      'index.js',
    );

    if (!fs.existsSync(resolvedPath)) {
      throw new Error('missing-ui-dist');
    }

    return (await import(pathToFileURL(resolvedPath).href)) as UiGeneratorModule;
  } catch {
    throw new Error(
      'Could not load @plumbus/ui. Install or link @plumbus/ui in the application before running `plumbus ui` commands.',
    );
  }
}

function writeGeneratedFiles(outputRoot: string, files: GeneratedFile[]): string[] {
  const written: string[] = [];

  for (const file of files) {
    writeFile(path.join(outputRoot, file.path), file.content);
    written.push(path.join(outputRoot, file.path));
  }

  return written;
}

interface ScaffoldWriteResult {
  written: string[];
  skipped: string[];
}

/**
 * Write scaffold/template files with overwrite protection.
 * Files that already exist on disk are skipped unless `force` is true.
 * Returns lists of written and skipped file paths.
 */
function writeScaffoldFiles(
  outputRoot: string,
  files: GeneratedFile[],
  force?: boolean,
): ScaffoldWriteResult {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const fullPath = path.join(outputRoot, file.path);
    if (!force && fs.existsSync(fullPath)) {
      skipped.push(path.join(outputRoot, file.path));
    } else {
      writeFile(fullPath, file.content);
      written.push(path.join(outputRoot, file.path));
    }
  }

  return { written, skipped };
}

function printMigrationSummary(migration: import('../utils.js').MigrationResult): void {
  const total =
    migration.movedFiles.length + migration.rewrittenImports.length + migration.deletedPaths.length;
  if (total === 0) return;

  info('Migrating legacy UI structure...');
  for (const moved of migration.movedFiles) {
    warn(`  Moved: ${moved}`);
  }
  for (const deleted of migration.deletedPaths) {
    warn(`  Removed: ${deleted}`);
  }
  if (migration.rewrittenImports.length > 0) {
    warn(`  Rewrote imports in ${migration.rewrittenImports.length} file(s)`);
  }
  success('Legacy migration complete');
}

/** Auto-detect the frontend output dir. If a Next.js frontend exists, write there. */
function resolveGenerateOutDir(explicit: string | undefined): string {
  if (explicit) return explicit;
  // In a monorepo, default to the frontend package
  const monorepo = detectMonorepoLayout();
  if (monorepo.isMonorepo && monorepo.frontendDir) {
    return 'frontend';
  }
  // Check common Next.js frontend locations
  for (const candidate of ['frontend', 'web', 'client', 'app']) {
    const tsconfigPath = path.join(process.cwd(), candidate, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      return candidate;
    }
  }
  return '.plumbus/generated/ui';
}

export function registerUiCommand(program: Command): void {
  const ui = program
    .command('ui')
    .description('Generate frontend source files and scaffolds with @plumbus/ui');

  ui.command('generate')
    .description('Generate UI modules (client, hooks, auth, form hints) from discovered contracts')
    .option(
      '--out-dir <path>',
      'Output directory (auto-detects frontend/generated if a Next.js app exists)',
    )
    .option('--base-url <url>', 'Base URL prepended to generated API calls', '')
    .option('--auth-provider <provider>', 'Auth provider for generated auth helpers', 'jwt')
    .option('--token-key <key>', 'Storage key for generated auth helpers')
    .option('--multi-tenant', 'Include tenant helpers in generated auth module')
    .option('--include-jsdoc', 'Emit JSDoc comments in generated client and hook modules')
    .option(
      '--split-locale-bundles',
      'Emit per-locale message bundles under i18n/locales/ (default: single i18n/messages.ts)',
    )
    .option('--json', 'Output generated file list as JSON')
    .action(async (opts: UiGenerateOptions) => {
      info('Loading @plumbus/ui generators...');
      const generators = await loadUiGenerators();

      info('Discovering capabilities and flows...');
      const resources = await discoverResources();
      const outDir = resolveGenerateOutDir(opts.outDir);
      const outputRoot = resolvePath(outDir);
      info(`Writing UI modules to ${outDir}`);

      // Auto-migrate legacy structure before writing new files
      const migration = migrateUiLegacyStructure(outputRoot);
      printMigrationSummary(migration);

      const files = generateUiModuleFiles(
        resources.capabilities,
        resources.flows,
        generators,
        opts,
        '',
        resources.translations,
      );
      const written = writeGeneratedFiles(outputRoot, files);

      // Also write to .plumbus/generated/ui/ as the contract artifact cache
      const plumbusOutDir = resolvePath('.plumbus/generated/ui');
      if (outputRoot !== plumbusOutDir) {
        writeGeneratedFiles(plumbusOutDir, files);
      }

      if (opts.json) {
        console.log(JSON.stringify({ generated: written }, null, 2));
        return;
      }

      for (const file of written) {
        success(`Generated ${path.relative(process.cwd(), file)}`);
      }
    });

  ui.command('nextjs [output-dir]')
    .description('Scaffold a Next.js frontend wired to generated Plumbus UI modules')
    .option('--app-name <name>', 'Application name used in the generated Next.js app')
    .option('--api-base-url <url>', 'Upstream Plumbus API base URL', 'http://localhost:3000')
    .option('--base-url <url>', 'Client base URL used by generated frontend modules')
    .option('--auth-provider <provider>', 'Auth provider for generated auth helpers', 'jwt')
    .option('--token-key <key>', 'Storage key for generated auth helpers')
    .option('--multi-tenant', 'Include tenant helpers in generated auth module')
    .option('--include-jsdoc', 'Emit JSDoc comments in generated client and hook modules')
    .option('--no-auth', 'Disable auth wiring in the generated Next.js app')
    .option('--force', 'Overwrite existing scaffold files (page.tsx, layout.tsx, etc.)')
    .option('--json', 'Output generated file list as JSON')
    .action(async (outputDir: string | undefined, opts: UiNextjsOptions) => {
      info('Loading @plumbus/ui generators...');
      const generators = await loadUiGenerators();

      info('Discovering capabilities and flows...');
      const resources = await discoverResources();
      const appName = opts.appName ?? path.basename(process.cwd());
      const outputRoot = resolvePath(outputDir ?? 'frontend');

      // Auto-migrate legacy structure before writing new files
      const migration = migrateUiLegacyStructure(outputRoot);
      printMigrationSummary(migration);

      // Generate template scaffold files (page.tsx, layout.tsx, login, signup, etc.)
      const templateFiles = generators.generateNextjsTemplate(
        { appName, auth: opts.auth, apiBaseUrl: opts.apiBaseUrl },
        resources.capabilities,
      );

      // Generate contract-derived module files (client.ts, hooks.ts, auth.ts, form-hints.ts, i18n)
      const moduleFiles = generateUiModuleFiles(
        resources.capabilities,
        resources.flows,
        generators,
        { ...opts, baseUrl: opts.baseUrl },
        '',
        resources.translations,
      );

      // Module files are always regenerated — they are derived from contracts
      const written = writeGeneratedFiles(outputRoot, [...moduleFiles, nextEnvTypesFile()]);

      // Scaffold files are protected: skip if they already exist, unless --force
      const scaffold = writeScaffoldFiles(outputRoot, templateFiles, opts.force);
      written.push(...scaffold.written);

      // Also write contract artifacts to .plumbus/generated/ui/
      writeGeneratedFiles(resolvePath('.plumbus/generated/ui'), moduleFiles);

      if (opts.json) {
        console.log(JSON.stringify({ generated: written, skipped: scaffold.skipped }, null, 2));
        return;
      }

      for (const file of written) {
        success(`Generated ${path.relative(process.cwd(), file)}`);
      }

      if (scaffold.skipped.length > 0) {
        warn('');
        warn(
          `Skipped ${scaffold.skipped.length} existing scaffold file(s) to avoid overwriting custom code:`,
        );
        for (const file of scaffold.skipped) {
          warn(`  ⊘ ${path.relative(process.cwd(), file)}`);
        }
        warn('');
        warn('To overwrite these files, re-run with --force');
      }
    });

  // ── plumbus ui e2e ──
  ui.command('e2e [output-dir]')
    .description('Scaffold vitest + Playwright E2E test files by scanning the frontend pages')
    .option('--frontend-dir <dir>', 'Frontend directory to scan for pages', 'frontend')
    .option('--base-url <url>', 'Base URL for E2E tests', 'http://localhost:3001')
    .action(
      async (outputDir: string | undefined, opts: { frontendDir: string; baseUrl: string }) => {
        const frontendDir = resolvePath(opts.frontendDir);
        const outRoot = resolvePath(outputDir ?? path.join(opts.frontendDir, 'e2e'));

        info('Scanning frontend pages for ActionPanel usage...');
        const pages = discoverFrontendPages(frontendDir);

        if (pages.length === 0) {
          info('No pages with ActionPanel forms found.');
          return;
        }

        // Generate vitest e2e config
        const configContent = generateE2EVitestConfig(opts.baseUrl);
        writeFile(path.join(outRoot, 'vitest.config.e2e.ts'), configContent);
        success(`Generated vitest.config.e2e.ts`);

        // Generate test files
        for (const page of pages) {
          const testContent = generateE2ETest(page);
          const testPath = path.join(outRoot, `${page.route.replace(/^\//, '') || 'home'}.e2e.ts`);
          writeFile(testPath, testContent);
          success(`Generated ${path.relative(process.cwd(), testPath)}`);
        }

        info(`\nE2E tests generated in ${path.relative(process.cwd(), outRoot)}`);
        info(
          `Run with: plumbus e2e --config ${path.relative(process.cwd(), path.join(outRoot, 'vitest.config.e2e.ts'))}`,
        );
      },
    );
}
