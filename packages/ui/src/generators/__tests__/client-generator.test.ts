import type { CapabilityContract } from 'plumbus-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FlowTriggerInput } from '../client-generator.js';
import {
  generateCapabilityTypes,
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
  it('generates Input and Output type aliases', () => {
    const code = generateCapabilityTypes(makeCap());
    expect(code).toContain('export type GetInvoiceInput');
    expect(code).toContain('export type GetInvoiceOutput');
    expect(code).toContain('Record<string, unknown>');
  });

  it('converts name to PascalCase', () => {
    const code = generateCapabilityTypes(makeCap({ name: 'list-all-orders' }));
    expect(code).toContain('ListAllOrdersInput');
    expect(code).toContain('ListAllOrdersOutput');
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
    expect(code).toContain('body.code');
    expect(code).toContain('body.metadata');
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
    expect(code).toContain('import type { GetInvoiceInput, GetInvoiceOutput } from "./client.js"');
    expect(code).toContain('import { getInvoice } from "./client.js"');
    expect(code).toContain('useGetInvoice');
    expect(code).toContain('useApproveRefund');
  });
});
