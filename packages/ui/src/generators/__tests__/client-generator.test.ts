import type { CapabilityContract } from '@plumbus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FlowTriggerInput } from '../client-generator.js';
import {
  generateCapabilityTypes,
  capabilityClientFnName,
  flowTriggerFnName,
  generateClientModule,
  generateErrorTypes,
  generateFlowTrigger,
  generateHooksModule,
  generateMutationHook,
  generateQueryHook,
  generateReactHook,
  generateTypedClient,
} from '../client-generator.js';

// ── Test Fixtures ──

function makeCap(overrides: Partial<CapabilityContract> = {}): CapabilityContract {
  return {
    name: 'getInvoice',
    kind: 'query',
    domain: 'billing',
    description: 'Retrieve an invoice',
    input: z.object({ invoiceId: z.string() }),
    output: z.object({ amount: z.number() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ amount: 0 }),
    ...overrides,
  } as CapabilityContract;
}

function makeActionCap(): CapabilityContract {
  return makeCap({
    name: 'approveRefund',
    kind: 'action',
    domain: 'billing',
    description: 'Approve a refund request',
  });
}

// ── generateCapabilityTypes ──

describe('generateCapabilityTypes', () => {
  it('generates Input and Output type aliases from Zod schemas', () => {
    const code = generateCapabilityTypes(makeCap());
    expect(code).toContain('export type GetInvoiceInput');
    expect(code).toContain('export type GetInvoiceOutput');
    expect(code).toContain('invoiceId: string');
    expect(code).toContain('amount: number');
  });

  it('generates Record<string, unknown> when schema has no fields', () => {
    const code = generateCapabilityTypes(makeCap({ input: z.object({}) }));
    expect(code).toContain('Record<string, unknown>');
  });

  it('handles optional and enum fields', () => {
    const cap = makeCap({
      input: z.object({
        name: z.string(),
        role: z.enum(['admin', 'user']),
        bio: z.string().optional(),
      }),
    });
    const code = generateCapabilityTypes(cap);
    expect(code).toContain('name: string');
    expect(code).toContain('role: "admin" | "user"');
    expect(code).toContain('bio?: string');
  });

  it('converts name to PascalCase', () => {
    const code = generateCapabilityTypes(makeCap({ name: 'list-all-orders' }));
    expect(code).toContain('ListAllOrdersInput');
    expect(code).toContain('ListAllOrdersOutput');
  });

  it('unwraps ZodEffects from superRefine to the inner object shape', () => {
    const cap = makeCap({
      input: z
        .object({
          courseIntakeId: z.string().uuid(),
          sortBy: z.literal('name').default('name'),
        })
        .superRefine(() => undefined),
    });
    const code = generateCapabilityTypes(cap);
    expect(code).toContain('courseIntakeId: string');
    expect(code).not.toContain('GetInvoiceInput = unknown');
  });

  it('leaves an output .transform() as unknown rather than the pre-transform shape', () => {
    const cap = makeCap({
      // A transform's OUTPUT type is its function's return value, which Zod does not
      // expose statically; emitting `{ cents: number }` would be confidently wrong.
      output: z.object({ cents: z.number() }).transform((o) => ({ dollars: o.cents / 100 })),
    });
    const code = generateCapabilityTypes(cap);
    expect(code).toContain('GetInvoiceOutput = unknown');
    expect(code).not.toContain('cents: number');
  });

  it('emits the source shape for an input .transform() (client sends the pre-transform value)', () => {
    const cap = makeCap({
      // In INPUT position the wire carries the pre-transform value, so the source
      // schema is the correct type — not `unknown`.
      input: z.object({ raw: z.string() }).transform((o) => ({ parsed: o.raw })),
    });
    const code = generateCapabilityTypes(cap);
    expect(code).toContain('raw: string');
    expect(code).not.toContain('GetInvoiceInput = unknown');
  });

  it('marks a ZodEffects-wrapped optional field as optional', () => {
    const cap = makeCap({
      input: z.object({
        name: z.string(),
        note: z
          .string()
          .optional()
          .superRefine(() => undefined),
      }),
    });
    const code = generateCapabilityTypes(cap);
    expect(code).toContain('note?: string');
  });

  it('handles array and nullable fields', () => {
    const cap = makeCap({
      input: z.object({
        tags: z.array(z.string()),
        note: z.string().nullable(),
      }),
    });
    const code = generateCapabilityTypes(cap);
    expect(code).toContain('tags: string[]');
    expect(code).toContain('note: string | null');
  });
});

// ── generateTypedClient ──

describe('generateTypedClient', () => {
  it('generates a GET client for query capabilities', () => {
    const code = generateTypedClient(makeCap());
    expect(code).toContain('export async function getInvoice');
    expect(code).toContain('method: "GET"');
    expect(code).toContain('URLSearchParams');
    expect(code).toContain('/api/billing/get-invoice');
  });

  it('generates a POST client for action capabilities', () => {
    const code = generateTypedClient(makeActionCap());
    expect(code).toContain('export async function approveRefund');
    expect(code).toContain('method: "POST"');
    expect(code).toContain('body: JSON.stringify(input)');
  });

  it('uses baseUrl config', () => {
    const code = generateTypedClient(makeCap(), { baseUrl: 'https://api.example.com' });
    expect(code).toContain('https://api.example.com/api/billing/get-invoice');
  });

  it('includes JSDoc when configured', () => {
    const code = generateTypedClient(makeCap(), { includeJsDoc: true });
    expect(code).toContain('/** Retrieve an invoice */');
  });

  it('generates proper error handling', () => {
    const code = generateTypedClient(makeCap());
    expect(code).toContain('if (!response.ok)');
    expect(code).toContain('throw Object.assign');
    expect(code).toContain('const err = body.error ?? body');
    expect(code).toContain('err.code');
    expect(code).toContain('err.metadata');
  });

  it('supports AbortSignal', () => {
    const code = generateTypedClient(makeCap());
    expect(code).toContain('signal?: AbortSignal');
    expect(code).toContain('signal: options?.signal');
  });
});

// ── generateQueryHook ──

describe('generateQueryHook', () => {
  it('generates a React query hook', () => {
    const code = generateQueryHook(makeCap());
    expect(code).toContain('export function useGetInvoice');
    expect(code).toContain('GetInvoiceInput');
    expect(code).toContain('GetInvoiceOutput');
    expect(code).toContain('useState');
    expect(code).toContain('useEffect');
  });

  it('includes cancellation logic', () => {
    const code = generateQueryHook(makeCap());
    expect(code).toContain('let cancelled = false');
    expect(code).toContain('return () => { cancelled = true; }');
  });

  it('returns data, loading, error', () => {
    const code = generateQueryHook(makeCap());
    expect(code).toContain('return { data, loading, error }');
  });

  it('accepts optional onError callback', () => {
    const code = generateQueryHook(makeCap());
    expect(code).toContain('options?: { onError?: (err: Error) => void }');
  });

  it('calls toast.error by default on error', () => {
    const code = generateQueryHook(makeCap());
    expect(code).toContain('toast.error(e.message)');
  });

  it('calls onError instead of toast when provided', () => {
    const code = generateQueryHook(makeCap());
    expect(code).toContain('if (options?.onError) options.onError(e)');
    expect(code).toContain('else toast.error(e.message)');
  });
});

// ── generateMutationHook ──

describe('generateMutationHook', () => {
  it('generates a mutation hook for action capabilities', () => {
    const code = generateMutationHook(makeActionCap());
    expect(code).toContain('export function useApproveRefund');
    expect(code).toContain('ApproveRefundInput');
    expect(code).toContain('mutate');
    expect(code).toContain('reset');
  });

  it('returns mutate, data, loading, error, reset', () => {
    const code = generateMutationHook(makeActionCap());
    expect(code).toContain('return { mutate, data, loading, error, reset }');
  });

  it('accepts optional onError callback', () => {
    const code = generateMutationHook(makeActionCap());
    expect(code).toContain('options?: { onError?: (err: Error) => void }');
  });

  it('calls toast.error by default on mutation error', () => {
    const code = generateMutationHook(makeActionCap());
    expect(code).toContain('toast.error(err.message)');
  });

  it('calls onError instead of toast when provided', () => {
    const code = generateMutationHook(makeActionCap());
    expect(code).toContain('if (options?.onError) options.onError(err)');
    expect(code).toContain('else toast.error(err.message)');
  });

  it('re-throws error after handling', () => {
    const code = generateMutationHook(makeActionCap());
    expect(code).toContain('throw err;');
  });
});

// ── generateReactHook ──

describe('generateReactHook', () => {
  it('dispatches query hook for query capabilities', () => {
    const code = generateReactHook(makeCap());
    expect(code).toContain('useGetInvoice');
    expect(code).toContain('useEffect');
  });

  it('dispatches mutation hook for action capabilities', () => {
    const code = generateReactHook(makeActionCap());
    expect(code).toContain('useApproveRefund');
    expect(code).toContain('mutate');
  });
});

// ── generateFlowTrigger ──

describe('generateFlowTrigger', () => {
  const flow: FlowTriggerInput = {
    name: 'refundApproval',
    domain: 'billing',
    description: 'Start refund approval flow',
  };

  it('generates a flow trigger function', () => {
    const code = generateFlowTrigger(flow);
    expect(code).toContain('export async function startRefundApproval');
    expect(code).toContain('RefundApprovalFlowInput');
    expect(code).toContain('/api/billing/refund-approval/start');
    expect(code).toContain('method: "POST"');
  });

  it('returns executionId and status', () => {
    const code = generateFlowTrigger(flow);
    expect(code).toContain('executionId: string');
    expect(code).toContain('status: string');
  });

  it('defaults domain to flows', () => {
    const code = generateFlowTrigger({ name: 'onboarding' });
    expect(code).toContain('/api/flows/onboarding/start');
  });

  it('includes JSDoc when configured', () => {
    const code = generateFlowTrigger(flow, { includeJsDoc: true });
    expect(code).toContain('/** Start flow: Start refund approval flow */');
  });
});

// ── generateErrorTypes ──

describe('generateErrorTypes', () => {
  it('generates PlumbusApiError interface', () => {
    const code = generateErrorTypes();
    expect(code).toContain('export interface PlumbusApiError');
    expect(code).toContain('status: number');
    expect(code).toContain('code?: string');
    expect(code).toContain('message: string');
  });

  it('generates type guard', () => {
    const code = generateErrorTypes();
    expect(code).toContain('export function isPlumbusApiError');
    expect(code).toContain('error is PlumbusApiError');
  });
});

// ── client export names ──

describe('capabilityClientFnName', () => {
  it('matches generateTypedClient export name', () => {
    const cap = makeCap({ name: 'list-all-orders' });
    expect(capabilityClientFnName(cap)).toBe('listAllOrders');
    const code = generateTypedClient(cap);
    expect(code).toContain('export async function listAllOrders');
  });
});

describe('flowTriggerFnName', () => {
  it('matches generateFlowTrigger export name', () => {
    const flow: FlowTriggerInput = { name: 'refund-flow', domain: 'billing' };
    expect(flowTriggerFnName(flow)).toBe('startRefundFlow');
    const code = generateFlowTrigger(flow);
    expect(code).toContain('export async function startRefundFlow');
  });
});

// ── generateClientModule ──

describe('generateClientModule', () => {
  it('generates a complete client module', () => {
    const caps = [makeCap(), makeActionCap()];
    const flows: FlowTriggerInput[] = [{ name: 'refundFlow', domain: 'billing' }];
    const code = generateClientModule(caps, flows);

    expect(code).toContain('Auto-generated by @plumbus/ui');
    expect(code).toContain('GetInvoiceInput');
    expect(code).toContain('ApproveRefundInput');
    expect(code).toContain('RefundFlowFlowInput');
    expect(code).toContain('getInvoice');
    expect(code).toContain('approveRefund');
    expect(code).toContain('startRefundFlow');
    expect(code).toContain('PlumbusApiError');
  });
});

// ── generateHooksModule ──

describe('generateHooksModule', () => {
  it('generates a hooks module with imports', () => {
    const caps = [makeCap(), makeActionCap()];
    const code = generateHooksModule(caps);

    expect(code).toContain('Auto-generated by @plumbus/ui');
    expect(code).toContain('import { useState, useEffect } from "react"');
    expect(code).toContain(
      'import type { GetInvoiceInput, GetInvoiceOutput } from "../lib/client"',
    );
    expect(code).toContain('import { getInvoice } from "../lib/client"');
    expect(code).toContain('useGetInvoice');
    expect(code).toContain('useApproveRefund');
  });

  it('imports toast from sonner by default', () => {
    const caps = [makeCap()];
    const code = generateHooksModule(caps);
    expect(code).toContain('import { toast } from "sonner"');
  });

  it('uses custom toast import when configured', () => {
    const caps = [makeCap()];
    const code = generateHooksModule(caps, { toastImport: 'my-toast-lib' });
    expect(code).toContain('import { toast } from "my-toast-lib"');
    expect(code).not.toContain('sonner');
  });
});
