import { createRequire } from 'node:module';
import type { BrowserType } from 'playwright';

const require = createRequire(import.meta.url);

type BrowserName = 'chromium' | 'firefox' | 'webkit';

/**
 * Every unit test file imports `@plumbus/core/testing`, and most never open a browser.
 * Loading Playwright (about 280 modules) on first use instead of at import keeps it out
 * of their start-up; `chromium.launch()` and the rest behave as before.
 */
function lazyBrowserType(name: BrowserName): BrowserType {
  const browserType = () => (require('playwright') as typeof import('playwright'))[name];
  return new Proxy({} as BrowserType, {
    get(_target, property) {
      const target = browserType();
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has: (_target, property) => property in browserType(),
  });
}

export const chromium = lazyBrowserType('chromium');
export const firefox = lazyBrowserType('firefox');
export const webkit = lazyBrowserType('webkit');
