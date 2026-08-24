import type { CapabilityContract } from '@plumbus/core';
import { capabilityClientFnName, flowTriggerFnName, generateClientModule } from '@plumbus/ui';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { hostPermission } from '../constants.js';
import { generateAuthStore } from '../auth-store.js';
import { generateBackground } from '../background.js';
import { generateBrowserExtensionScaffold } from '../scaffold.js';
import { generateInvoke } from '../invoke.js';
import { generateContent } from '../content.js';
import { generatePackageJson } from '../package-json.js';
import { generatePopupFiles } from '../popup.js';
import { generateWxtConfig } from '../wxt-config.js';
function makeCap(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: 'listItems',
    kind: 'query',
    domain: 'items',
    input: z.object({}),
    output: z.object({ items: z.array(z.string()) }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ items: [] }),
    exposeAs: ['api'],
    ...overrides,
  } as CapabilityContract;
}

describe('hostPermission', () => {
  it('uses origin only', () => {
    expect(hostPermission('https://api.example.com/v1')).toBe('https://api.example.com/*');
    expect(hostPermission('https://api.example.com/')).toBe('https://api.example.com/*');
    expect(hostPermission('http://localhost:3000')).toBe('http://localhost:3000/*');
  });
});

describe('generateWxtConfig', () => {
  it('branches API host access for Manifest V2 (Firefox) vs V3 (Chrome)', () => {
    const file = generateWxtConfig({
      appName: 'Demo',
      apiBaseUrl: 'https://api.example.com',
      browsers: ['chrome', 'firefox'],
      registryEntries: [],
    });
    expect(file.content).toContain('manifest: ({ manifestVersion })');
    expect(file.content).toContain('manifestVersion === 2');
    expect(file.content).toContain(
      'manifestVersion === 2 ? [\'storage\', "https://api.example.com/*"]',
    );
    expect(file.content).toContain('host_permissions: manifestVersion === 2 ? [] :');
    expect(file.content).toContain('["https://api.example.com/*"]');
  });

  it('respects firefox-only browser option', () => {
    const file = generateWxtConfig({
      appName: 'Demo',
      apiBaseUrl: 'https://api.example.com',
      browsers: ['firefox'],
      registryEntries: [],
    });
    expect(file.content).toContain('firefox');
  });
});

describe('generateAuthStore', () => {
  it('uses browser.storage.local and absolute auth URLs', () => {
    const file = generateAuthStore({
      appName: 'Demo',
      apiBaseUrl: 'https://api.example.com/',
      registryEntries: [],
    });
    expect(file.content).toContain('browser.storage.local');
    expect(file.content).toContain('API_BASE_URL}/api/auth/refresh');
    expect(file.content).toContain('const API_BASE_URL = "https://api.example.com"');
    expect(file.content).not.toMatch(/fetch\("\/api\/auth/);
  });

  it('single-flights concurrent refreshAuth calls', () => {
    const file = generateAuthStore({
      appName: 'Demo',
      apiBaseUrl: 'https://api.example.com',
      registryEntries: [],
    });
    expect(file.content).toContain('let refreshInFlight');
    expect(file.content).toContain('async function refreshAuthOnce()');
    expect(file.content).toContain('if (refreshInFlight)');
    expect(file.content).toContain('refreshInFlight = refreshAuthOnce().finally');
  });
});

describe('generateBackground', () => {
  it('includes message type and registry entries', () => {
    const file = generateBackground({
      appName: 'Demo',
      apiBaseUrl: 'https://api.example.com',
      registryEntries: [
        { messageKey: 'listItems', exportName: 'listItems' },
        { messageKey: 'startOnboarding', exportName: 'startOnboarding' },
      ],
    });
    expect(file.content).toContain('wxt/utils/define-background');
    expect(file.content).not.toContain('wxt/sandbox');
    expect(file.content).toContain('INVOKE_MESSAGE_TYPE');
    expect(file.content).toContain("from '../src/invoke.js'");
    expect(file.content).toContain('(input) => wrapHandler(client.listItems');
    expect(file.content).not.toMatch(/:\s*wrapHandler\(client\.listItems/);
    expect(file.content).toContain('.catch((err) => sendResponse');
    expect(file.content).toContain('try {\n    const headers = await authHeaders()');
    expect(file.content).toContain('if (!isUnauthorized(retryErr))');
    expect(file.content).toContain('UNKNOWN_CAPABILITY');
    expect(file.content).toContain('defineBackground');
  });
});

describe('generateInvoke', () => {
  it('returns TRANSPORT_ERROR when sendMessage rejects', () => {
    const file = generateInvoke();
    expect(file.content).toContain("code: 'TRANSPORT_ERROR'");
    expect(file.content).toMatch(/try \{\s*raw = await browser\.runtime\.sendMessage/s);
  });
});

describe('generateContent', () => {
  it('uses WXT 0.20 content-script helper and runtime registration', () => {
    const file = generateContent();
    expect(file.content).toContain('wxt/utils/define-content-script');
    expect(file.content).toContain("registration: 'runtime'");
    expect(file.content).toContain('matches: []');
  });
});

describe('generatePopupFiles', () => {
  it('imports src modules from popup depth and JSON-encodes login URL', () => {
    const files = generatePopupFiles({
      config: {
        appName: 'Demo',
        apiBaseUrl: 'https://api.example.com',
        registryEntries: [],
        sampleMessageKey: 'listItems',
      },
      capabilities: [makeCap()],
      flows: [],
    });
    const app = files.find((f) => f.path === 'entrypoints/popup/App.tsx');
    expect(app?.content).toContain("from '../../src/auth-store.js'");
    expect(app?.content).toContain('fetch("https://api.example.com/api/auth/login"');
    expect(app?.content).not.toMatch(/fetch\(`https:\/\//);
  });

  it('escapes braces in JSX app title', () => {
    const files = generatePopupFiles({
      config: {
        appName: 'Acme {Beta}',
        apiBaseUrl: 'https://api.example.com',
        registryEntries: [],
      },
      capabilities: [],
      flows: [],
    });
    const app = files.find((f) => f.path === 'entrypoints/popup/App.tsx');
    expect(app?.content).toContain('<h1>Acme &lbrace;Beta&rbrace;</h1>');
    const html = files.find((f) => f.path === 'entrypoints/popup/index.html');
    expect(html?.content).toContain('<title>Acme {Beta}</title>');
  });
});

describe('generatePackageJson', () => {
  it('omits firefox scripts when --browser chrome', () => {
    const file = generatePackageJson({
      appName: 'Demo',
      apiBaseUrl: 'https://api.example.com',
      browsers: ['chrome'],
      registryEntries: [],
    });
    expect(file.content).toContain('"dev:chrome"');
    expect(file.content).not.toContain('dev:firefox');
    expect(file.content).toContain('postinstall');
  });

  it('defaults dev to firefox when firefox-only', () => {
    const file = generatePackageJson({
      appName: 'Demo',
      apiBaseUrl: 'https://api.example.com',
      browsers: ['firefox'],
      registryEntries: [],
    });
    expect(file.content).toContain('"dev": "wxt -b firefox"');
    expect(file.content).not.toContain('dev:chrome');
  });
});

describe('registry ↔ client cross-file resolution', () => {
  it('every registry exportName exists on generated client module', () => {
    const caps = [
      makeCap(),
      makeCap({ name: 'get-item', kind: 'query', input: z.object({ id: z.string() }) }),
    ];
    const flows = [{ name: 'sync', domain: 'flows' }];
    const clientCode = generateClientModule(caps, flows, { baseUrl: 'https://api.example.com' });

    const registryEntries = [
      ...caps.map((c) => ({
        messageKey: capabilityClientFnName(c),
        exportName: capabilityClientFnName(c),
      })),
      {
        messageKey: flowTriggerFnName(flows[0]),
        exportName: flowTriggerFnName(flows[0]),
      },
    ];

    const bg = generateBackground({
      appName: 'Demo',
      apiBaseUrl: 'https://api.example.com',
      registryEntries,
    }).content;

    for (const entry of registryEntries) {
      expect(clientCode).toContain(`export async function ${entry.exportName}`);
      expect(bg).toContain(`client.${entry.exportName}`);
    }
  });
});

describe('generateBrowserExtensionScaffold', () => {
  it('emits expected shell paths', () => {
    const files = generateBrowserExtensionScaffold({
      config: {
        appName: 'Demo',
        apiBaseUrl: 'https://api.example.com',
        registryEntries: [{ messageKey: 'listItems', exportName: 'listItems' }],
        sampleMessageKey: 'listItems',
      },
      capabilities: [makeCap()],
      flows: [],
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('wxt.config.ts');
    expect(paths).toContain('entrypoints/background.ts');
    expect(paths).toContain('src/auth-store.ts');
    expect(paths).toContain('entrypoints/popup/App.tsx');
  });

  it('popup sample uses registry messageKey for zero-input invoke', () => {
    const files = generateBrowserExtensionScaffold({
      config: {
        appName: 'Demo',
        apiBaseUrl: 'https://api.example.com',
        registryEntries: [{ messageKey: 'listItems', exportName: 'listItems' }],
        sampleMessageKey: 'listItems',
      },
      capabilities: [makeCap()],
      flows: [],
    });
    const app = files.find((f) => f.path === 'entrypoints/popup/App.tsx');
    expect(app?.content).toContain('invoke("listItems", {})');
    expect(app?.content).not.toContain('Edit inputs');
  });
});
