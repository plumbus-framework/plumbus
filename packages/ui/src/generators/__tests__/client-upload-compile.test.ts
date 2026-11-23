// The generated client for uploads and streamed answers compiles under a strict consumer
// configuration (strict, noUnusedLocals), in both the single-module and the split layout.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityContract } from '@plumbus/core';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  generateCapabilityTypes,
  generateClientModule,
  generateSplitClientFiles,
  generateTypedClient,
  uploadFieldOf,
} from '../client-generator.js';

const tsc = join(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/.bin/tsc');
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function capabilities(): Promise<CapabilityContract[]> {
  const { streamedUploadInput, streamedBodyOutput } = await import('@plumbus/core');
  const base = {
    domain: 'billing',
    access: { roles: ['member'] },
    effects: { data: [], events: [], external: [], ai: false },
    exposeAs: ['api'],
    handler: async () => ({}),
  };
  return [
    {
      ...base,
      name: 'uploadReceipt',
      kind: 'action',
      input: z.object({
        invoiceId: z.string(),
        token: z.string(),
        file: streamedUploadInput({ maxBytes: 1024, contentTypes: ['application/pdf'] }) as never,
      }),
      output: z.object({ bytes: z.number() }),
    },
    {
      ...base,
      name: 'downloadReceipt',
      kind: 'query',
      input: z.object({ invoiceId: z.string() }),
      output: streamedBodyOutput as never,
    },
    {
      ...base,
      name: 'getInvoice',
      kind: 'query',
      input: z.object({ invoiceId: z.string() }),
      output: z.object({ amount: z.number() }),
    },
  ] as unknown as CapabilityContract[];
}

function compile(files: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), 'plumbus-ui-upload-'));
  dirs.push(dir);
  const all = {
    ...files,
    'lib/auth.ts':
      'export function csrfHeaders(_method: string): Record<string, string> { return {}; }\n',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ['lib/**/*.ts'],
    }),
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  try {
    execFileSync(tsc, ['-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`generated client does not compile:\n${(error as { stdout?: string }).stdout}`);
  }
}

describe('generated client for uploads', () => {
  it('passes the file beside the input and keeps the fields out of the URL', async () => {
    const [upload] = await capabilities();
    if (!upload) throw new Error('missing');
    expect(uploadFieldOf(upload)).toBe('file');
    const types = generateCapabilityTypes(upload);
    expect(types).toContain('invoiceId: string');
    expect(types).not.toContain('file');
    const code = generateTypedClient(upload);
    expect(code).toContain('body: Blob | ArrayBuffer | Uint8Array');
    expect(code).toContain('"x-plumbus-input": fields');
    expect(code).toContain('body: request.body as BodyInit');
    expect(code).not.toContain('JSON.stringify(input),');
  });

  it('compiles strictly as one module', async () => {
    compile({
      'lib/client.ts': generateClientModule(await capabilities(), [], {
        authModuleImport: './auth',
      }),
    });
  }, 60_000);

  it('compiles strictly as split modules, with no unused helper import', async () => {
    const files = generateSplitClientFiles(await capabilities(), [], {
      authModuleImport: './auth',
    });
    compile(Object.fromEntries(files.map((file) => [file.path, file.content])));
    const download = files.find((file) => file.path === 'lib/client/downloadReceipt.ts');
    expect(download?.content).not.toContain('unwrapEnvelope');
  }, 60_000);
});
