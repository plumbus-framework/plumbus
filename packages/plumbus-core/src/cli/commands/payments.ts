// ── plumbus payments ──
// Config + environment checks, webhook setup, and the billing catalog for the
// optional @plumbus/payments add-on. Core never imports the add-on: it loads the app's
// `app/payments/index.ts`, which exports the `payments` object from
// createPayments(), and talks to it through the small interface below.

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from 'commander';

/** A config or environment finding reported by the payments add-on. */
export interface PaymentsCliFinding {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
}

/** What a catalog sync or check did or would do. */
export interface PaymentsCliCatalogResult {
  /** Provider price id per catalog lookup key. */
  prices: Record<string, string>;
  changes: string[];
}

/** The parts of a `createPayments()` result the CLI uses. */
export interface PaymentsCliModule {
  provider: { id: string; displayName: string };
  config: { webhooks: { path: string } };
  diagnose(options?: { live?: boolean; webhookUrl?: string }): Promise<PaymentsCliFinding[]>;
  setupWebhooks(options: { url: string }): Promise<{
    destinations: Array<{
      id: string;
      name: string;
      format: string;
      url: string;
      secret: string | null;
      created: boolean;
    }>;
  }>;
  /** Billing catalog (payments 0.2+); absent in older add-on releases. */
  syncCatalog?(): Promise<PaymentsCliCatalogResult>;
  checkCatalog?(): Promise<PaymentsCliCatalogResult>;
}

export const PAYMENTS_ENTRY_FILES = ['app/payments/index.ts', 'app/payments/index.js'] as const;

function isPaymentsModule(value: unknown): value is PaymentsCliModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { diagnose?: unknown }).diagnose === 'function' &&
    typeof (value as { setupWebhooks?: unknown }).setupWebhooks === 'function' &&
    typeof (value as { provider?: { id?: unknown } }).provider?.id === 'string'
  );
}

/** Load `payments` (or the default export) from app/payments/index.{ts,js}. */
export async function loadAppPayments(cwd = process.cwd()): Promise<PaymentsCliModule | null> {
  const entry = PAYMENTS_ENTRY_FILES.map((file) => path.resolve(cwd, file)).find((file) =>
    fs.existsSync(file),
  );
  if (!entry) return null;

  let unregister: (() => void) | undefined;
  try {
    const req = createRequire(import.meta.url);
    const tsx = await import(pathToFileURL(req.resolve('tsx/esm/api')).href);
    unregister = tsx.register();
  } catch {
    // tsx unavailable: only a compiled app/payments/index.js can load.
  }
  try {
    const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    const candidate = mod.payments ?? mod.default;
    return isPaymentsModule(candidate) ? candidate : null;
  } finally {
    unregister?.();
  }
}

const SYMBOL: Record<PaymentsCliFinding['level'], string> = {
  error: '✖',
  warning: '⚠',
  info: 'ℹ',
};

export function formatPaymentsFindings(findings: readonly PaymentsCliFinding[]): string[] {
  if (findings.length === 0) return ['✔ No payments findings'];
  return findings.map(
    (f) => `${SYMBOL[f.level]} ${f.level} [${f.code}]${f.path ? ` ${f.path}:` : ''} ${f.message}`,
  );
}

export function formatCatalogResult(
  result: PaymentsCliCatalogResult,
  mode: 'sync' | 'check',
): string[] {
  const lines: string[] = [];
  if (result.changes.length === 0) {
    lines.push(
      mode === 'sync' ? '✔ Catalog already up to date' : '✔ Catalog matches billing in the config',
    );
  } else {
    lines.push(mode === 'sync' ? 'Changed:' : 'Differs (run plumbus payments catalog sync):');
    for (const change of result.changes) lines.push(`  ${mode === 'sync' ? '✔' : '✖'} ${change}`);
  }
  const prices = Object.entries(result.prices);
  if (prices.length > 0) {
    lines.push('Prices:');
    for (const [lookupKey, id] of prices) lines.push(`  ${lookupKey} → ${id}`);
  }
  return lines;
}

/** Exit policy for `plumbus payments doctor`: errors fail; warnings fail only when asked. */
export function paymentsDoctorShouldFail(
  findings: readonly PaymentsCliFinding[],
  opts: { failOnWarning?: boolean } = {},
): boolean {
  return findings.some(
    (f) => f.level === 'error' || (opts.failOnWarning === true && f.level === 'warning'),
  );
}

async function requirePayments(): Promise<PaymentsCliModule> {
  let payments: PaymentsCliModule | null = null;
  try {
    payments = await loadAppPayments();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('');
    console.error(`Could not load app/payments/index.ts: ${message}`);
    if (message.includes('@plumbus/payments')) {
      console.error('Run: pnpm add @plumbus/payments @plumbus/payments-stripe');
    }
    console.error('');
    process.exit(1);
  }
  if (!payments) {
    console.error('');
    console.error('Missing app/payments/index.ts exporting `payments` from createPayments().');
    console.error('See node_modules/@plumbus/payments/instructions/framework.md');
    console.error('');
    process.exit(1);
  }
  return payments;
}

export function registerPaymentsCommand(program: Command): void {
  const payments = program
    .command('payments')
    .description(
      'Payments add-on — check config and provider setup, create webhook destinations, sync the billing catalog',
    );

  payments
    .command('doctor')
    .description(
      'Check the payments config; with --live, also check keys and webhooks at the provider',
    )
    .option('--live', 'Call the provider to check keys, Connect access, and webhook destinations')
    .option(
      '--webhook-url <url>',
      'Public URL of the payments webhook route, to compare with the provider',
    )
    .option('--fail-on-warning', 'Exit with failure on warnings as well as errors')
    .option('--json', 'Print findings as JSON')
    .action(
      async (opts: {
        live?: boolean;
        webhookUrl?: string;
        failOnWarning?: boolean;
        json?: boolean;
      }) => {
        const app = await requirePayments();
        const findings = await app.diagnose({
          live: opts.live === true,
          ...(opts.webhookUrl ? { webhookUrl: opts.webhookUrl } : {}),
        });
        if (opts.json) {
          console.log(JSON.stringify({ provider: app.provider.id, findings }, null, 2));
        } else {
          console.log(`Payments provider: ${app.provider.displayName}`);
          for (const line of formatPaymentsFindings(findings)) console.log(line);
        }
        if (paymentsDoctorShouldFail(findings, { failOnWarning: opts.failOnWarning })) {
          process.exitCode = 1;
        }
      },
    );

  payments
    .command('webhooks')
    .description('Manage provider webhook destinations')
    .command('setup')
    .description('Create the webhook destinations the payments add-on needs, pointing at --url')
    .requiredOption('--url <url>', 'Public URL of the payments webhook route')
    .option('--json', 'Print the result as JSON')
    .action(async (opts: { url: string; json?: boolean }) => {
      const app = await requirePayments();
      const result = await app.setupWebhooks({ url: opts.url });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const destination of result.destinations) {
        console.log(
          `${destination.created ? '✔ created' : '• exists '} ${destination.name} (${destination.format}) → ${destination.url}`,
        );
        if (destination.secret) {
          console.log(`    signing secret: ${destination.secret}`);
        }
      }
      if (result.destinations.some((d) => d.secret)) {
        console.log('');
        console.log(
          'Store every signing secret in your secret manager and pass them all to the provider (e.g. stripeProvider({ webhookSecrets })). They are shown only once.',
        );
      }
    });

  const catalog = payments
    .command('catalog')
    .description(
      'The billing catalog (plans, prices, features, meters) from `billing` in the payments config',
    );

  for (const mode of ['sync', 'check'] as const) {
    catalog
      .command(mode)
      .description(
        mode === 'sync'
          ? 'Create or update the catalog at the provider so it matches the config'
          : 'Compare the catalog at the provider with the config without changing it; fails when they differ',
      )
      .option('--json', 'Print the result as JSON')
      .action(async (opts: { json?: boolean }) => {
        const app = await requirePayments();
        const run = mode === 'sync' ? app.syncCatalog : app.checkCatalog;
        if (!run) {
          console.error('');
          console.error(
            'This @plumbus/payments release has no billing catalog; upgrade to 0.2 or later.',
          );
          console.error('');
          process.exit(1);
        }
        const result = await run.call(app);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Payments provider: ${app.provider.displayName}`);
          for (const line of formatCatalogResult(result, mode)) console.log(line);
        }
        if (mode === 'check' && result.changes.length > 0) process.exitCode = 1;
      });
  }
}
