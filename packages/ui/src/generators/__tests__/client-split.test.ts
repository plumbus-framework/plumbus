import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CapabilityContract } from '@plumbus/core';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  generateClientModule,
  generateHooksModule,
  generateSplitClientFiles,
  generateSplitHooksFiles,
  generateTypedClient,
} from '../client-generator.js';

function cap(
  name: string,
  kind: CapabilityContract['kind'],
  domain = 'billing',
): CapabilityContract {
  return {
    name,
    kind,
    domain,
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
  } as CapabilityContract;
}

const getInvoice = cap('getInvoice', 'query');
const approveRefund = cap('approveRefund', 'action');
const capabilities = [getInvoice, cap('listInvoices', 'query'), approveRefund];
const flows = [{ name: 'refundReview', domain: 'billing' }];

const valueExports = (code: string) =>
  [...code.matchAll(/^export (?:async )?function (\w+)|^export \{ (\w+) \}/gm)]
    .map((m) => m[1] ?? m[2])
    .sort();
const file = (files: Array<{ path: string; content: string }>, p: string) =>
  files.find((f) => f.path === p)?.content ?? '';

describe('dedupeQueries', () => {
  it('is off by default: no shared-request code in the client', () => {
    expect(generateClientModule(capabilities, flows)).not.toContain('sharedQuery');
  });

  it('shares concurrent GETs, but never one with its own AbortSignal, and never a POST', () => {
    const config = { dedupeQueries: true };
    const get = generateTypedClient(getInvoice, config);
    expect(get).toContain('if (options?.signal) return run();');
    expect(get).toContain('return sharedQuery(');
    expect(generateTypedClient(approveRefund, config)).not.toContain('sharedQuery(');
    // A change makes running GETs stale: a POST clears them before it is sent.
    expect(generateTypedClient(approveRefund, config)).toContain('forgetSharedQueries();');
    expect(generateTypedClient(getInvoice, config)).not.toContain('forgetSharedQueries');
    const module = generateClientModule(capabilities, flows, config);
    expect(module.match(/function sharedQuery</g)).toHaveLength(1);
    expect(module).toContain('structuredClone(value)');
  });
});

describe('generateSplitClientFiles', () => {
  const files = generateSplitClientFiles(capabilities, flows);

  it('keeps lib/client.ts exporting the same names as the single-file client', () => {
    expect(valueExports(file(files, 'lib/client.ts'))).toEqual(
      valueExports(generateClientModule(capabilities, flows)),
    );
  });

  it('puts each endpoint in its own module and marks the folder side-effect free', () => {
    expect(file(files, 'lib/client/getInvoice.ts')).toContain('export async function getInvoice(');
    expect(file(files, 'lib/client/getInvoice.ts')).not.toContain('listInvoices');
    expect(file(files, 'lib/client/startRefundReview.ts')).toContain(
      'export async function startRefundReview(',
    );
    expect(JSON.parse(file(files, 'lib/client/package.json'))).toEqual({ sideEffects: false });
  });

  it('imports auth one folder up, and honours a .js import extension', () => {
    expect(file(files, 'lib/client/_runtime.ts')).toContain('from "../auth"');
    const js = generateSplitClientFiles(capabilities, flows, {
      authModuleImport: './auth.js',
      importExtension: '.js',
    });
    expect(file(js, 'lib/client/_runtime.ts')).toContain('from "../auth.js"');
    expect(file(js, 'lib/client/getInvoice.ts')).toContain('from "./_types.js"');
    expect(file(js, 'lib/client.ts')).toContain('from "./client/getInvoice.js"');
  });

  it('imports sharedQuery into query modules and forgetSharedQueries into changes', () => {
    const shared = generateSplitClientFiles(capabilities, flows, { dedupeQueries: true });
    expect(file(shared, 'lib/client/getInvoice.ts')).toContain(
      'import { clientFetchInit, sharedQuery }',
    );
    expect(file(shared, 'lib/client/approveRefund.ts')).toContain(
      'import { clientFetchInit, forgetSharedQueries }',
    );
    expect(file(shared, 'lib/client/startRefundReview.ts')).toContain('forgetSharedQueries();');
  });
});

describe('generateSplitHooksFiles', () => {
  const files = generateSplitHooksFiles(capabilities);

  it('keeps hooks/hooks.ts exporting the same names as the single-file hooks', () => {
    expect(valueExports(file(files, 'hooks/hooks.ts'))).toEqual(
      valueExports(generateHooksModule(capabilities)),
    );
  });

  it('imports only what each hook uses, and its client function module directly', () => {
    expect(file(files, 'hooks/generated/useApproveRefund.ts')).toContain(
      'import { useState } from "react";',
    );
    expect(file(files, 'hooks/generated/useGetInvoice.ts')).toContain(
      'import { useState, useEffect } from "react";',
    );
    expect(file(files, 'hooks/generated/useGetInvoice.ts')).toContain(
      'from "../../lib/client/getInvoice"',
    );
    expect(JSON.parse(file(files, 'hooks/generated/package.json'))).toEqual({ sideEffects: false });
  });
});

describe('split output compiles', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plumbus-split-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('type-checks the split client and hooks, and a consumer of the barrels', () => {
    const all = [
      ...generateSplitClientFiles(capabilities, flows, { dedupeQueries: true }),
      ...generateSplitHooksFiles(capabilities),
      {
        path: 'lib/auth.ts',
        content: 'export function getAuthHeaders(): Record<string, string> { return {}; }\n',
      },
      { path: 'stubs/sonner.ts', content: 'export const toast = { error(_m: string) {} };\n' },
      {
        path: 'consumer.ts',
        content: [
          'import { getInvoice, isPlumbusApiError, startRefundReview, type GetInvoiceOutput } from "./lib/client";',
          'import { useApproveRefund, useGetInvoice } from "./hooks/hooks";',
          'export const used: unknown[] = [getInvoice, isPlumbusApiError, startRefundReview, useApproveRefund, useGetInvoice];',
          'export type Out = GetInvoiceOutput;',
        ].join('\n'),
      },
    ];
    for (const f of all) {
      mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      writeFileSync(path.join(dir, f.path), f.content);
    }
    const program = ts.createProgram(
      all.filter((f) => f.path.endsWith('.ts')).map((f) => path.join(dir, f.path)),
      {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
        baseUrl: dir,
        paths: { sonner: ['stubs/sonner.ts'] },
        typeRoots: [path.resolve('node_modules/@types')],
        types: ['react'],
        skipLibCheck: true,
      },
    );
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diagnostics).toEqual([]);
  });
});

describe('shared GETs at runtime', () => {
  async function loadClient() {
    const code = generateClientModule(capabilities, flows, { dedupeQueries: true });
    const js = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const calls: string[] = [];
    const fetch = async (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${url}`);
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ ok: true, at: calls.length }), { status: 200 });
    };
    const exports: Record<string, any> = {};
    const require = (id: string) => (id === './auth' ? { getAuthHeaders: () => ({}) } : {});
    new Function('exports', 'require', 'fetch', js)(exports, require, fetch);
    return { client: exports, calls };
  }

  it('sends one request for concurrent identical GETs, and hands each caller its own copy', async () => {
    const { client, calls } = await loadClient();
    const [a, b] = await Promise.all([
      client.getInvoice({ id: '1' }),
      client.getInvoice({ id: '1' }),
    ]);
    expect(calls).toEqual(['GET /api/billing/get-invoice?id=1']);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('does not share different inputs, calls with an AbortSignal, or a GET started after a POST', async () => {
    const { client, calls } = await loadClient();
    await Promise.all([client.getInvoice({ id: '1' }), client.getInvoice({ id: '2' })]);
    expect(calls).toHaveLength(2);
    await Promise.all([
      client.getInvoice({ id: '3' }),
      client.getInvoice({ id: '3' }, { signal: new AbortController().signal }),
    ]);
    expect(calls).toHaveLength(4);
    const running = client.getInvoice({ id: '4' });
    await client.approveRefund({ id: '4' });
    await Promise.all([running, client.getInvoice({ id: '4' })]);
    expect(calls.filter((c) => c === 'GET /api/billing/get-invoice?id=4')).toHaveLength(2);
  });
});
