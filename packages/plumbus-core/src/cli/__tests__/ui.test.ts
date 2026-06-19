import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import type { FlowDefinition } from '../../types/flow.js';
import {
  generateE2EVitestConfig,
  generateNextjsAppFiles,
  generateUiModuleFiles,
  type UiGeneratorModule,
} from '../commands/ui.js';

function mockCapability(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: 'getUser',
    kind: 'query',
    domain: 'users',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ id: 'user-1' }),
    ...overrides,
  } as CapabilityContract;
}

function mockFlow(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    name: 'syncProfile',
    domain: 'users',
    input: z.object({ userId: z.string() }),
    steps: [],
    ...overrides,
  } as FlowDefinition;
}

function mockUiGenerators(): UiGeneratorModule {
  return {
    generateClientModule: () => 'client-module',
    generateHooksModule: () => 'hooks-module',
    generateAuthModule: () => 'auth-module',
    generateFormHintsModule: () => 'form-hints-module',
    generateNextjsTemplate: () => [
      { path: 'app/page.tsx', content: 'page-module' },
      { path: 'app/layout.tsx', content: 'layout-module' },
    ],
  };
}

describe('plumbus ui helpers', () => {
  it('generates UI module file entries', () => {
    const files = generateUiModuleFiles([mockCapability()], [mockFlow()], mockUiGenerators(), {
      baseUrl: '/api',
    });

    expect(files.map((file) => file.path)).toEqual([
      'lib/client.ts',
      'hooks/hooks.ts',
      'lib/auth.ts',
      'lib/form-hints.ts',
    ]);
  });

  it('generates a Next.js scaffold with generated modules', () => {
    const files = generateNextjsAppFiles(
      'AcmeApp',
      [mockCapability()],
      [mockFlow()],
      mockUiGenerators(),
      { apiBaseUrl: 'http://localhost:3000' },
    );

    const paths = files.map((file) => file.path);
    expect(paths).toContain('app/page.tsx');
    expect(paths).toContain('next-env.d.ts');
    expect(paths).toContain('lib/client.ts');
    expect(paths).toContain('hooks/hooks.ts');
    expect(paths).toContain('lib/auth.ts');
    expect(paths).toContain('lib/form-hints.ts');
  });

  it('separates template files from module files in nextjs output', () => {
    const files = generateNextjsAppFiles(
      'TestApp',
      [mockCapability()],
      [mockFlow()],
      mockUiGenerators(),
      { apiBaseUrl: 'http://localhost:3000' },
    );

    // Template files (from generateNextjsTemplate)
    expect(files.map((f) => f.path)).toContain('app/page.tsx');
    expect(files.map((f) => f.path)).toContain('app/layout.tsx');

    // Module files (from generateUiModuleFiles) — always regenerated
    const moduleFiles = ['lib/client.ts', 'hooks/hooks.ts', 'lib/auth.ts', 'lib/form-hints.ts'];
    for (const modFile of moduleFiles) {
      expect(files.map((f) => f.path)).toContain(modFile);
    }
  });

  it('generates an E2E Vitest config without external imports', () => {
    const config = generateE2EVitestConfig('http://localhost:3001');

    expect(config).toContain('export default {');
    expect(config).not.toContain('vitest/config');
  });
});
