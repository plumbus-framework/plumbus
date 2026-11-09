import { execFileSync } from 'node:child_process';
import * as playwright from 'playwright';
import { describe, expect, it } from 'vitest';
import { chromium, firefox, webkit } from '../index.js';

describe('Playwright re-export', () => {
  // Run outside Vitest's shared module cache so another test cannot hide an eager
  // import. playwright-core is CommonJS, so its files appear in require.cache.
  it('does not load Playwright on a cold import of the testing entry', () => {
    const entry = new URL('../../../dist/testing/index.js', import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const testing = await import(${JSON.stringify(entry)});
      const loaded = () => Object.keys(require.cache).filter((path) => /node_modules\\/playwright(-core)?\\//.test(path)).length;
      const before = loaded();
      testing.chromium.name();
      console.log(JSON.stringify({ before, after: loaded() }));
    `,
      ],
      { encoding: 'utf8' },
    );
    const { before, after } = JSON.parse(output) as { before: number; after: number };
    expect(before).toBe(0);
    expect(after).toBeGreaterThan(0);
  });

  it('behaves like the Playwright browser types', () => {
    expect([chromium.name(), firefox.name(), webkit.name()]).toEqual([
      'chromium',
      'firefox',
      'webkit',
    ]);
    expect(chromium.executablePath()).toBe(playwright.chromium.executablePath());
    expect('launch' in chromium).toBe(true);
    expect(typeof chromium.launch).toBe('function');
  });
});
