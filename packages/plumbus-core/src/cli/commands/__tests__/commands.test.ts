import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../../types/capability.js';
import { GovernanceSeverity } from '../../../types/enums.js';
import { generateProjectStructure } from '../create.js';
import { checkNodeVersion } from '../doctor.js';
import { generateClientFunction, generateReactHook } from '../generate.js';
import { generateCopilotInstructions } from '../init.js';
import { discoverSeedFiles } from '../seed.js';
import { generateUiModuleFiles } from '../ui.js';
import { ruleCapabilityAccessPolicy, ruleCapabilityEffects } from '../verify.js';

// ── Helpers ──

function makeCapability(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: 'getUser',
    kind: 'query',
    domain: 'users',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string(), name: z.string() }),
    effects: { data: ['User'], events: [], external: [], ai: false },
    access: { roles: ['admin'] },
    handler: async (_ctx, input) => ({
      id: input.id,
      name: 'Test User',
    }),
    ...overrides,
  } as CapabilityContract;
}

// ── create.ts ──

describe('generateProjectStructure', () => {
  it('generates expected files for a new project', () => {
    const files = generateProjectStructure('my-app', {});

    expect(files.has('package.json')).toBe(true);
    expect(files.has('tsconfig.json')).toBe(true);
    expect(files.has('README.md')).toBe(true);
  });

  it('includes app name in package.json', () => {
    const files = generateProjectStructure('my-app', {});
    const pkg = JSON.parse(files.get('package.json') ?? '{}') as { name: string };

    expect(pkg.name).toBe('my-app');
  });
});

// ── doctor.ts ──

describe('checkNodeVersion', () => {
  it('reports ok for current Node.js version', () => {
    const result = checkNodeVersion();

    // We're running on Node 20+ in CI/dev
    expect(result.name).toBe('node');
    expect(['ok', 'warn']).toContain(result.status);
    expect(result.message).toContain('Node.js');
  });
});

// ── generate.ts ──

describe('generateClientFunction', () => {
  it('generates a fetch-based client function', () => {
    const cap = makeCapability();
    const code = generateClientFunction(cap);

    expect(code).toContain('async function getUser');
    expect(code).toContain('/api/users/get-user');
    expect(code).toContain('GET');
  });

  it('uses POST for action capabilities', () => {
    const cap = makeCapability({ kind: 'action', name: 'createOrder' });
    const code = generateClientFunction(cap);

    expect(code).toContain('POST');
    expect(code).toContain('createOrder');
  });
});

describe('generateReactHook', () => {
  it('generates a React hook for a query', () => {
    const cap = makeCapability();
    const code = generateReactHook(cap);

    expect(code).toContain('useGetUser');
    expect(code).toContain('useState');
  });
});

// ── init.ts ──

describe('generateCopilotInstructions', () => {
  it('generates markdown with framework instructions', () => {
    const content = generateCopilotInstructions(false);

    expect(content).toContain('Plumbus');
    expect(content).toContain('capabilities');
    expect(content).toContain('@plumbus/ui');
  });

  it('generates inline variant', () => {
    const content = generateCopilotInstructions(true);

    expect(content).toContain('Plumbus');
  });
});

describe('generateUiModuleFiles', () => {
  it('returns file entries for generated UI modules', () => {
    const cap = makeCapability();
    const files = generateUiModuleFiles(
      [cap],
      [],
      {
        generateClientModule: () => 'client',
        generateHooksModule: () => 'hooks',
        generateAuthModule: () => 'auth',
        generateFormHintsModule: () => 'forms',
        generateNextjsTemplate: () => [],
      },
      {},
    );

    expect(files.map((file) => file.path)).toEqual([
      'client.ts',
      'hooks.ts',
      'auth.ts',
      'form-hints.ts',
    ]);
  });
});

// ── verify.ts ──

describe('ruleCapabilityAccessPolicy', () => {
  it('reports no signals when capabilities have access policies', () => {
    const caps = [makeCapability({ access: { roles: ['admin'] } })];
    const signals = ruleCapabilityAccessPolicy(caps);

    expect(signals).toHaveLength(0);
  });

  it('reports high severity when a capability has no access policy', () => {
    const caps = [makeCapability({ access: {} as any })];
    const signals = ruleCapabilityAccessPolicy(caps);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe(GovernanceSeverity.High);
    expect(signals[0]?.rule).toContain('access-policy');
  });
});

describe('ruleCapabilityEffects', () => {
  it('reports no signals for reasonable effect counts', () => {
    const caps = [makeCapability()];
    const signals = ruleCapabilityEffects(caps);

    expect(signals).toHaveLength(0);
  });

  it('warns when effects exceed threshold', () => {
    const manyEffects = {
      data: Array.from({ length: 6 }, (_, i) => `Entity${i}`),
      events: Array.from({ length: 4 }, (_, i) => `event.${i}`),
      external: ['stripe'],
      ai: false,
    };
    const caps = [makeCapability({ effects: manyEffects })];
    const signals = ruleCapabilityEffects(caps);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.rule).toContain('excessive-effects');
  });
});

// ── seed.ts ──

describe('discoverSeedFiles', () => {
  it('returns empty array for non-existent directory', () => {
    const result = discoverSeedFiles('/non/existent/path');

    expect(result).toEqual([]);
  });

  it('discovers .ts seed files and sorts them', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-seed-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '002-data.ts'), '');
      fs.writeFileSync(path.join(tmpDir, '001-users.ts'), '');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '');

      const result = discoverSeedFiles(tmpDir);

      expect(result).toHaveLength(2);
      expect(result[0]).toContain('001-users.ts');
      expect(result[1]).toContain('002-data.ts');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('excludes .d.ts and .test.ts files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-seed-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'seed.ts'), '');
      fs.writeFileSync(path.join(tmpDir, 'seed.d.ts'), '');
      fs.writeFileSync(path.join(tmpDir, 'seed.test.ts'), '');

      const result = discoverSeedFiles(tmpDir);

      expect(result).toHaveLength(1);
      expect(result[0]).toContain('seed.ts');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
