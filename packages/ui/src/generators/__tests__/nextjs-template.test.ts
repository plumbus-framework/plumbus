import type { CapabilityContract } from '@plumbus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { NextjsTemplateConfig } from '../nextjs-template.js';
import {
  generateAuthProvider,
  generateCapabilityPage,
  generateGlobalsCss,
  generateHomePage,
  generateLayout,
  generateNextjsTemplate,
  generatePackageJson,
  generatePlaceholderFiles,
  generatePostcssConfig,
  generateTsConfig,
} from '../nextjs-template.js';

// ── Fixtures ──

function makeConfig(overrides: Partial<NextjsTemplateConfig> = {}): NextjsTemplateConfig {
  return { appName: 'MyApp', auth: true, ...overrides };
}

function makeQueryCap(): CapabilityContract {
  return {
    name: 'getInvoice',
    kind: 'query',
    domain: 'billing',
    description: 'Get an invoice',
    input: z.object({ invoiceId: z.string() }),
    output: z.object({ amount: z.number() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ amount: 0 }),
  } as CapabilityContract;
}

function makeActionCap(): CapabilityContract {
  return {
    name: 'approveRefund',
    kind: 'action',
    domain: 'billing',
    input: z.object({}),
    output: z.object({}),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({}),
  } as CapabilityContract;
}

// ── generatePackageJson ──

describe('generatePackageJson', () => {
  it('generates valid JSON', () => {
    const file = generatePackageJson(makeConfig());
    const parsed = JSON.parse(file.content);
    expect(parsed.name).toBe('my-app');
    expect(parsed.scripts.dev).toBe('next dev');
  });

  it('uses kebab-case name', () => {
    const file = generatePackageJson(makeConfig({ appName: 'my Cool App' }));
    const parsed = JSON.parse(file.content);
    expect(parsed.name).toBe('my-cool-app');
  });

  it('does not include framework-provided deps (provided by @plumbus/ui)', () => {
    const file = generatePackageJson(makeConfig());
    const parsed = JSON.parse(file.content);
    expect(parsed.dependencies.next).toBeUndefined();
    expect(parsed.dependencies.react).toBeUndefined();
    expect(parsed.dependencies.tailwindcss).toBeUndefined();
    expect(parsed.dependencies['@tailwindcss/postcss']).toBeUndefined();
    expect(parsed.devDependencies.typescript).toBeUndefined();
  });

  it('outputs to package.json path', () => {
    expect(generatePackageJson(makeConfig()).path).toBe('package.json');
  });
});

// ── generateTsConfig ──

describe('generateTsConfig', () => {
  it('generates valid JSON for tsconfig', () => {
    const file = generateTsConfig();
    const parsed = JSON.parse(file.content);
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.jsx).toBe('preserve');
    expect(parsed.compilerOptions.module).toBe('esnext');
  });

  it('outputs to tsconfig.json path', () => {
    expect(generateTsConfig().path).toBe('tsconfig.json');
  });
});

// ── generateLayout ──

describe('generateLayout', () => {
  it('generates layout with auth provider when auth is true', () => {
    const file = generateLayout(makeConfig({ auth: true }));
    expect(file.path).toBe('app/layout.tsx');
    expect(file.content).toContain('AuthProvider');
    expect(file.content).toContain('import { AuthProvider }');
  });

  it('generates layout without auth provider when auth is false', () => {
    const file = generateLayout(makeConfig({ auth: false }));
    expect(file.content).not.toContain('AuthProvider');
  });

  it('includes app name in metadata', () => {
    const file = generateLayout(makeConfig({ appName: 'TestApp' }));
    expect(file.content).toContain('title: "TestApp"');
  });

  it('imports globals.css', () => {
    const file = generateLayout(makeConfig());
    expect(file.content).toContain('import "./globals.css"');
  });
});

// ── generateGlobalsCss ──

describe('generateGlobalsCss', () => {
  it('generates CSS with Tailwind import', () => {
    const file = generateGlobalsCss();
    expect(file.path).toBe('app/globals.css');
    expect(file.content).toContain('@import "tailwindcss"');
  });

  it('includes base resets', () => {
    const file = generateGlobalsCss();
    expect(file.content).toContain('box-sizing: border-box');
    expect(file.content).toContain('min-height: 100vh');
    expect(file.content).toContain('margin: 0');
  });
});

// ── generatePostcssConfig ──

describe('generatePostcssConfig', () => {
  it('generates postcss config with Tailwind plugin', () => {
    const file = generatePostcssConfig();
    expect(file.path).toBe('postcss.config.mjs');
    expect(file.content).toContain('@tailwindcss/postcss');
  });
});

// ── generateHomePage ──

describe('generateHomePage', () => {
  it('generates a home page component', () => {
    const file = generateHomePage(makeConfig());
    expect(file.path).toBe('app/page.tsx');
    expect(file.content).toContain('export default function Home');
    expect(file.content).toContain('MyApp');
    expect(file.content).toContain('Welcome to your Plumbus application');
  });
});

// ── generateCapabilityPage ──

describe('generateCapabilityPage', () => {
  it('generates a query page with data display', () => {
    const file = generateCapabilityPage(makeQueryCap());
    expect(file.path).toBe('app/get-invoice/page.tsx');
    expect(file.content).toContain('"use client"');
    expect(file.content).toContain('useGetInvoice');
    expect(file.content).toContain('data, loading, error');
    expect(file.content).toContain('Loading...');
  });

  it('imports hooks from @/generated/ path', () => {
    const file = generateCapabilityPage(makeQueryCap());
    expect(file.content).toContain('from "@/generated/hooks"');
  });

  it('generates an action page with form', () => {
    const file = generateCapabilityPage(makeActionCap());
    expect(file.path).toBe('app/approve-refund/page.tsx');
    expect(file.content).toContain('"use client"');
    expect(file.content).toContain('useApproveRefund');
    expect(file.content).toContain('mutate');
    expect(file.content).toContain('<form');
    expect(file.content).toContain('handleSubmit');
  });
});

// ── generateAuthProvider ──

describe('generateAuthProvider', () => {
  it('generates AuthProvider component', () => {
    const file = generateAuthProvider();
    expect(file.path).toBe('components/AuthProvider.tsx');
    expect(file.content).toContain('"use client"');
    expect(file.content).toContain('createContext');
    expect(file.content).toContain('export function AuthProvider');
    expect(file.content).toContain('export function useAuthContext');
  });

  it('imports from generated auth', () => {
    const file = generateAuthProvider();
    expect(file.content).toContain('@/generated/auth');
    expect(file.content).toContain('getStoredToken');
    expect(file.content).toContain('isTokenExpired');
    expect(file.content).toContain('refreshSession');
  });
});

// ── generatePlaceholderFiles ──

describe('generatePlaceholderFiles', () => {
  it('generates gitkeep files for generated and hooks dirs', () => {
    const files = generatePlaceholderFiles();
    const paths = files.map((f) => f.path);
    expect(paths).toContain('generated/.gitkeep');
    expect(paths).toContain('hooks/.gitkeep');
  });
});

// ── generateNextjsTemplate ──

describe('generateNextjsTemplate', () => {
  it('generates all core files', () => {
    const files = generateNextjsTemplate(makeConfig());
    const paths = files.map((f) => f.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('tsconfig.json');
    expect(paths).toContain('app/globals.css');
    expect(paths).toContain('postcss.config.mjs');
    expect(paths).toContain('app/layout.tsx');
    expect(paths).toContain('app/page.tsx');
    expect(paths).toContain('generated/.gitkeep');
    expect(paths).toContain('hooks/.gitkeep');
    expect(paths).toContain('components/AuthProvider.tsx');
  });

  it('excludes AuthProvider when auth is false', () => {
    const files = generateNextjsTemplate(makeConfig({ auth: false }));
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('components/AuthProvider.tsx');
  });

  it('includes capability pages when provided', () => {
    const caps = [makeQueryCap(), makeActionCap()];
    const files = generateNextjsTemplate(makeConfig(), caps);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('app/get-invoice/page.tsx');
    expect(paths).toContain('app/approve-refund/page.tsx');
  });

  it('generates no capability pages when capabilities are omitted', () => {
    const files = generateNextjsTemplate(makeConfig());
    const standardAppPaths = new Set([
      'app/layout.tsx',
      'app/page.tsx',
      'app/globals.css',
      'app/error.tsx',
      'app/loading.tsx',
      'app/api/plumbus/[...path]/route.ts',
    ]);
    const capPages = files.filter(
      (f) => f.path.startsWith('app/') && !standardAppPaths.has(f.path),
    );
    expect(capPages).toHaveLength(0);
  });
});
