import type { CapabilityContract } from '@plumbus/core';
import { capabilityClientFnName, generateClientModule } from '@plumbus/ui';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateBrowserExtensionScaffold } from '../scaffold.js';

const STUB_TYPES = `declare module 'wxt/utils/define-background' {
  export function defineBackground(fn: () => void): unknown;
}

declare module 'wxt/utils/define-content-script' {
  export function defineContentScript(cfg: {
    matches: string[];
    registration?: 'manifest' | 'runtime';
    main: () => void;
  }): unknown;
}

declare namespace React {
  interface FormEvent<T = Element> {
    preventDefault(): void;
  }
  interface ChangeEvent<T = Element> {
    target: T;
  }
}

declare module 'react' {
  export function useState<T>(initial: T): [T, (value: T) => void];
  export function useEffect(effect: () => void, deps?: unknown[]): void;
}

declare module 'react/jsx-runtime' {
  export const jsx: (type: unknown, props: unknown, key?: unknown) => unknown;
  export const jsxs: (type: unknown, props: unknown, key?: unknown) => unknown;
  export const Fragment: unknown;
}

declare module 'react-dom/client' {
  export function createRoot(container: Element): { render(children: unknown): void };
}

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>;
  }
}

declare const browser: {
  runtime: {
    sendMessage: (message: unknown) => Promise<unknown>;
    onMessage: {
      addListener: (
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ) => void;
    };
  };
  storage: {
    local: {
      get: (keys: string | string[]) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
    };
  };
};
`;

function makeCap(): CapabilityContract {
  return {
    name: 'listItems',
    kind: 'query',
    domain: 'items',
    input: z.object({}),
    output: z.object({ items: z.array(z.string()) }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ items: [] }),
  } as CapabilityContract;
}

function writeTree(root: string, files: Array<{ path: string; content: string }>): void {
  for (const file of files) {
    const full = join(root, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content, 'utf8');
  }
}

function runTsc(dir: string): string {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const tscBin = join(packageRoot, '../../node_modules/typescript/bin/tsc');
  try {
    execFileSync(process.execPath, [tscBin, '-p', dir], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return '';
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return [e.stdout, e.stderr].filter(Boolean).join('\n');
  }
}

describe('generated scaffold compiles', { timeout: 30_000 }, () => {
  it('entrypoints, popup, and client type-check under strict', () => {
    const cap = makeCap();
    const exportName = capabilityClientFnName(cap);
    const registryEntries = [{ messageKey: exportName, exportName }];
    const clientCode = generateClientModule([cap], [], { baseUrl: 'https://api.example.com' });

    const shellFiles = generateBrowserExtensionScaffold({
      config: {
        appName: 'CompileTest',
        apiBaseUrl: 'https://api.example.com',
        registryEntries,
        sampleMessageKey: exportName,
      },
      capabilities: [cap],
      flows: [],
    });

    const dir = mkdtempSync(join(tmpdir(), 'plumbus-ext-compile-'));
    writeTree(dir, [
      ...shellFiles,
      { path: 'src/client/api.ts', content: clientCode },
      { path: 'types/stubs.d.ts', content: STUB_TYPES },
      {
        path: 'tsconfig.json',
        content: JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              jsx: 'react-jsx',
              types: [],
            },
            include: [
              'entrypoints/**/*.ts',
              'entrypoints/**/*.tsx',
              'src/**/*.ts',
              'types/**/*.d.ts',
            ],
          },
          null,
          2,
        ),
      },
    ]);

    const stderr = runTsc(dir);
    expect(stderr, 'generated scaffold should type-check').toBe('');
  });

  it('popup with braced app name type-checks', () => {
    const cap = makeCap();
    const exportName = capabilityClientFnName(cap);
    const shellFiles = generateBrowserExtensionScaffold({
      config: {
        appName: 'Acme {Beta}',
        apiBaseUrl: 'https://api.example.com',
        registryEntries: [{ messageKey: exportName, exportName }],
        sampleMessageKey: exportName,
      },
      capabilities: [cap],
      flows: [],
    });

    const dir = mkdtempSync(join(tmpdir(), 'plumbus-ext-braces-'));
    writeTree(dir, [
      ...shellFiles,
      {
        path: 'src/client/api.ts',
        content: generateClientModule([cap], [], { baseUrl: 'https://api.example.com' }),
      },
      { path: 'types/stubs.d.ts', content: STUB_TYPES },
      {
        path: 'tsconfig.json',
        content: JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              jsx: 'react-jsx',
              types: [],
            },
            include: [
              'entrypoints/**/*.ts',
              'entrypoints/**/*.tsx',
              'src/**/*.ts',
              'types/**/*.d.ts',
            ],
          },
          null,
          2,
        ),
      },
    ]);

    const stderr = runTsc(dir);
    expect(stderr, 'braced app name scaffold should type-check').toBe('');
  });
});
