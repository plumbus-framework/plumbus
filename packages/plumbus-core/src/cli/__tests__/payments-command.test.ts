import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatCatalogResult,
  formatPaymentsFindings,
  loadAppPayments,
  paymentsDoctorShouldFail,
  registerPaymentsCommand,
} from '../commands/payments.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function appWith(source: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-payments-cli-'));
  dirs.push(dir);
  if (source !== null) {
    fs.mkdirSync(path.join(dir, 'app/payments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/payments/index.js'), source);
  }
  return dir;
}

const stubSource = (exportLine: string) => `
const payments = {
  provider: { id: 'stripe', displayName: 'Stripe' },
  config: { webhooks: { path: '/payments/webhooks/stripe' } },
  async diagnose() { return [{ level: 'warning', code: 'w', message: 'careful' }]; },
  async setupWebhooks() { return { destinations: [] }; },
  async syncCatalog() { return { prices: { 'plumbus:app:team:monthly': 'price_1' }, changes: ['create product plan team'] }; },
};
${exportLine}
`;

describe('plumbus payments — app loading', () => {
  it('returns null when the app has no app/payments entry', async () => {
    expect(await loadAppPayments(appWith(null))).toBeNull();
  });

  it('loads the named `payments` export or the default export', async () => {
    const named = await loadAppPayments(appWith(stubSource('export { payments };')));
    expect(named?.provider.id).toBe('stripe');
    expect(await named?.diagnose()).toEqual([{ level: 'warning', code: 'w', message: 'careful' }]);

    const fallback = await loadAppPayments(appWith(stubSource('export default payments;')));
    expect(fallback?.provider.displayName).toBe('Stripe');
    expect(await fallback?.syncCatalog?.()).toMatchObject({
      changes: ['create product plan team'],
    });
    expect(fallback?.checkCatalog).toBeUndefined();
  });

  it('ignores exports that are not a createPayments() result', async () => {
    expect(await loadAppPayments(appWith('export const payments = { provider: {} };'))).toBeNull();
  });
});

describe('plumbus payments — output and exit policy', () => {
  it('formats findings with level, code, and path', () => {
    expect(
      formatPaymentsFindings([
        { level: 'error', code: 'e1', message: 'broken', path: 'dashboards.express' },
        { level: 'info', code: 'i1', message: 'fyi' },
      ]),
    ).toEqual(['✖ error [e1] dashboards.express: broken', 'ℹ info [i1] fyi']);
    expect(formatPaymentsFindings([])).toEqual(['✔ No payments findings']);
  });

  it('fails on errors, and on warnings only when asked', () => {
    const warning = [{ level: 'warning' as const, code: 'w', message: 'x' }];
    expect(paymentsDoctorShouldFail(warning)).toBe(false);
    expect(paymentsDoctorShouldFail(warning, { failOnWarning: true })).toBe(true);
    expect(paymentsDoctorShouldFail([{ level: 'error', code: 'e', message: 'x' }])).toBe(true);
  });

  it('formats a catalog sync and a check', () => {
    const prices = { 'plumbus:app:team:monthly': 'price_1' };
    expect(formatCatalogResult({ prices, changes: [] }, 'sync')).toEqual([
      '✔ Catalog already up to date',
      'Prices:',
      '  plumbus:app:team:monthly → price_1',
    ]);
    expect(
      formatCatalogResult({ prices: {}, changes: ['create product plan team'] }, 'check'),
    ).toEqual(['Differs (run plumbus payments catalog sync):', '  ✖ create product plan team']);
  });

  it('registers doctor, webhooks setup, and catalog sync and check', () => {
    const program = new Command();
    registerPaymentsCommand(program);
    const payments = program.commands.find((c) => c.name() === 'payments');
    expect(payments?.commands.map((c) => c.name())).toEqual(['doctor', 'webhooks', 'catalog']);
    const catalog = payments?.commands.find((c) => c.name() === 'catalog');
    expect(catalog?.commands.map((c) => c.name())).toEqual(['sync', 'check']);
    const doctor = payments?.commands.find((c) => c.name() === 'doctor');
    expect(doctor?.options.map((o) => o.long)).toEqual([
      '--live',
      '--webhook-url',
      '--fail-on-warning',
      '--json',
    ]);
    const setup = payments?.commands.find((c) => c.name() === 'webhooks')?.commands[0];
    expect(setup?.name()).toBe('setup');
    expect(setup?.options.find((o) => o.long === '--url')?.required).toBe(true);
  });
});
