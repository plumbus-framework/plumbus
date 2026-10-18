import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createFastify } from '../../server/index.js';

// Run outside Vitest's shared module cache so another test cannot hide an eager
// dependency. These CommonJS packages appear in require.cache when evaluated.
describe('SDK dependency loading', () => {
  it('does not evaluate HTTP, SAML/XML or cron libraries on a cold public import', () => {
    const entry = new URL('../../../dist/index.js', import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      await import(${JSON.stringify(entry)});
      console.log(JSON.stringify(Object.keys(require.cache)));
    `,
      ],
      { encoding: 'utf8' },
    );
    const loaded = JSON.parse(output) as string[];
    expect(
      loaded.filter((path) =>
        /node_modules\/(fastify|@xmldom\/xmldom|xml-crypto|xpath|cron-parser|luxon)\//.test(path),
      ),
    ).toEqual([]);
  });

  it('keeps the SDK entry free of CLI commands and governance modules', () => {
    const entry = new URL('../../../dist/sdk.js', import.meta.url).href;
    const loader = `export async function resolve(s,c,n) {
      const r = await n(s,c);
      if (/plumbus-core\\/dist\\/(cli|governance)\\//.test(r.url)) throw new Error('tooling imported: '+r.url);
      return r;
    }`;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { register } from 'node:module';
      register('data:text/javascript,'+encodeURIComponent(${JSON.stringify(loader)}), import.meta.url);
      const sdk = await import(${JSON.stringify(entry)});
      if (!sdk.defineCapability || !sdk.createExecutionContext || !sdk.buildWorkerAiService) throw new Error('missing runtime API');
      console.log('sdk-ok');
    `,
      ],
      { encoding: 'utf8' },
    );
    expect(output).toContain('sdk-ok');
  });

  it('still creates a working HTTP server on demand', async () => {
    const app = createFastify({ logger: false });
    app.get('/probe', async () => ({ ok: true }));
    try {
      const response = await app.inject('/probe');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
