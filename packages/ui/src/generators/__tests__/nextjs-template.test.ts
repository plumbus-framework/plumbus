import type { CapabilityContract } from '@plumbus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { NextjsTemplateConfig } from '../nextjs-template.js';
import {
  generateAuthProvider,
  generateCapabilityPage,
  generateEnvLocal,
  generateGlobalsCss,
  generateHomePage,
  generateLayout,
  generateLoginPage,
  generateNextjsTemplate,
  generatePackageJson,
  generatePlaceholderFiles,
  generatePostcssConfig,
  generateProxy,
  generateSignupPage,
  generateTsConfig,
} from '../nextjs-template.js';

// ── Fixtures ──

function makeConfig(overrides: Partial<NextjsTemplateConfig> = {}): NextjsTemplateConfig {
  return { appName: 'MyApp', auth: true, apiBaseUrl: 'https://api.example.com', ...overrides };
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

  it('imports hooks from @/hooks/ path', () => {
    const file = generateCapabilityPage(makeQueryCap());
    expect(file.content).toContain('from "@/hooks/hooks"');
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
    const file = generateAuthProvider(makeConfig());
    expect(file.path).toBe('components/AuthProvider.tsx');
    expect(file.content).toContain('"use client"');
    expect(file.content).toContain('createContext');
    expect(file.content).toContain('export function AuthProvider');
    expect(file.content).toContain('export function useAuthContext');
  });

  it('imports bearer helpers by default', () => {
    const file = generateAuthProvider(makeConfig());
    expect(file.content).toContain('@/lib/auth');
    expect(file.content).toContain('getStoredToken');
    expect(file.content).toContain('isTokenExpired');
    expect(file.content).toContain('refreshSession');
  });

  it('uses loadSession for session transport', () => {
    const file = generateAuthProvider(makeConfig({ authTransport: 'session' }));
    expect(file.content).toContain('loadSession');
    expect(file.content).not.toContain('getStoredToken');
  });
});

// ── generatePlaceholderFiles ──

describe('generatePlaceholderFiles', () => {
  it('generates gitkeep files for hooks and lib dirs', () => {
    const files = generatePlaceholderFiles();
    const paths = files.map((f) => f.path);
    expect(paths).toContain('hooks/.gitkeep');
    expect(paths).toContain('lib/.gitkeep');
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
    expect(paths).toContain('hooks/.gitkeep');
    expect(paths).toContain('lib/.gitkeep');
    expect(paths).toContain('proxy.ts');
    expect(paths).toContain('components/AuthProvider.tsx');
    expect(paths).toContain('app/login/page.tsx');
    expect(paths).toContain('app/signup/page.tsx');
  });

  it('excludes AuthProvider and auth pages when auth is false', () => {
    const files = generateNextjsTemplate(makeConfig({ auth: false }));
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('components/AuthProvider.tsx');
    expect(paths).not.toContain('app/login/page.tsx');
    expect(paths).not.toContain('app/signup/page.tsx');
  });

  it('does not generate per-capability pages', () => {
    const caps = [makeQueryCap(), makeActionCap()];
    const files = generateNextjsTemplate(makeConfig(), caps);
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('app/get-invoice/page.tsx');
    expect(paths).not.toContain('app/approve-refund/page.tsx');
  });

  it('excludes signup page for session transport', () => {
    const files = generateNextjsTemplate(makeConfig({ authTransport: 'session' }));
    const paths = files.map((f) => f.path);
    expect(paths).toContain('app/login/page.tsx');
    expect(paths).toContain('app/login/error/page.tsx');
    expect(paths).not.toContain('app/signup/page.tsx');
  });

  it('renders auth callback error codes on session login surfaces', () => {
    const login = generateLoginPage({ authTransport: 'session' });
    expect(login.content).toContain('authErrorMessage');
    expect(login.content).toContain('searchParams.get("code")');
    const errorPage = generateNextjsTemplate(makeConfig({ authTransport: 'session' })).find(
      (file) => file.path === 'app/login/error/page.tsx',
    );
    expect(errorPage?.content).toContain('authErrorMessage');
    expect(errorPage?.content).toContain('requestId');
  });

  it('does not generate API proxy route', () => {
    const files = generateNextjsTemplate(makeConfig());
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('app/api/plumbus/[...path]/route.ts');
  });
  it('omits AUTH_SECRET for session transport env template', () => {
    const file = generateEnvLocal(makeConfig({ authTransport: 'session' }));
    expect(file.content).not.toContain('AUTH_SECRET=');
    expect(file.content).toContain('HttpOnly cookies');
  });

  it('writes the provided API base URL into .env.local', () => {
    const file = generateEnvLocal(makeConfig({ apiBaseUrl: 'https://api.example.com' }));
    expect(file.path).toBe('.env.local');
    expect(file.content).toContain('NEXT_PUBLIC_API_BASE_URL=https://api.example.com');
    expect(file.content).not.toContain('localhost:3000');
    expect(file.content).not.toContain('localhost:3001');
  });

  it('refuses to invent a localhost API port', () => {
    expect(() => generateEnvLocal({ appName: 'MyApp' })).toThrow(/apiBaseUrl is required/);
  });
});

// ── generateProxy ──

describe('generateProxy', () => {
  it('generates proxy.ts (not middleware.ts)', () => {
    const file = generateProxy(makeConfig());
    expect(file.path).toBe('proxy.ts');
  });

  it('exports a proxy function', () => {
    const file = generateProxy(makeConfig());
    expect(file.content).toContain('export function proxy(request: NextRequest)');
    expect(file.content).not.toContain('export function middleware');
  });

  it('documents API-layer auth instead of cookie gating when auth is enabled', () => {
    const file = generateProxy(makeConfig({ auth: true }));
    expect(file.content).toContain('NextResponse.next()');
    expect(file.content).toContain('Plumbus API layer');
    expect(file.content).not.toContain('protectedPaths');
    expect(file.content).not.toContain('auth_token');
  });

  it('passes through when auth is false', () => {
    const file = generateProxy(makeConfig({ auth: false }));
    expect(file.content).toContain('NextResponse.next()');
    expect(file.content).not.toContain('protectedPaths');
    expect(file.content).not.toContain('auth_token');
  });
});

// ── generateLoginPage ──

describe('generateLoginPage', () => {
  it('generates bearer login page at app/login/page.tsx', () => {
    const file = generateLoginPage(makeConfig());
    expect(file.path).toBe('app/login/page.tsx');
  });

  it('is a client component with email/password form for bearer transport', () => {
    const file = generateLoginPage(makeConfig());
    expect(file.content).toContain('"use client"');
    expect(file.content).toContain('<form');
    expect(file.content).toContain('email');
    expect(file.content).toContain('password');
  });

  it('generates provider picker for session transport', () => {
    const file = generateLoginPage(makeConfig({ authTransport: 'session' }));
    expect(file.content).toContain('fetchProviders');
    expect(file.content).toContain('startLogin');
    expect(file.content).not.toContain('password');
  });

  it('imports login from @/lib/auth for bearer transport', () => {
    const file = generateLoginPage(makeConfig());
    expect(file.content).toContain('from "@/lib/auth"');
  });

  it('links to signup page for bearer transport', () => {
    const file = generateLoginPage(makeConfig());
    expect(file.content).toContain('/signup');
  });
});

// ── generateSignupPage ──

describe('generateSignupPage', () => {
  it('generates signup page at app/signup/page.tsx', () => {
    const file = generateSignupPage();
    expect(file.path).toBe('app/signup/page.tsx');
  });

  it('is a client component with form', () => {
    const file = generateSignupPage();
    expect(file.content).toContain('"use client"');
    expect(file.content).toContain('<form');
    expect(file.content).toContain('name');
    expect(file.content).toContain('email');
    expect(file.content).toContain('password');
  });

  it('links to login page', () => {
    const file = generateSignupPage();
    expect(file.content).toContain('/login');
  });
});
