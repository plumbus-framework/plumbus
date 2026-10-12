// ── @plumbus/payments-stripe/testing ──
// Build and sign Stripe webhook bodies (snapshot and thin), and stub Stripe's
// HTTP API in-process so adapter code runs without network or keys.

import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../provider.js';

export interface SignedStripeDelivery {
  rawBody: Buffer;
  headers: Record<string, string>;
}

/** Sign a webhook body exactly like Stripe does (`Stripe-Signature: t=…,v1=…`). */
export function signStripeWebhook(input: {
  payload: string | Record<string, unknown>;
  secret: string;
  /** Unix seconds; default now. */
  timestamp?: number;
}): SignedStripeDelivery {
  const body = typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
  const header = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: input.secret,
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  });
  return {
    rawBody: Buffer.from(body),
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
  };
}

let eventCounter = 0;

/** A v1 snapshot event as a connected-account destination delivers it. */
export function stripeSnapshotEvent(input: {
  type: string;
  account: string | null;
  object: Record<string, unknown> & { id: string; object: string };
  livemode?: boolean;
  id?: string;
  created?: number;
}): Record<string, unknown> {
  return {
    id: input.id ?? `evt_test_${++eventCounter}`,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    created: input.created ?? Math.floor(Date.now() / 1000),
    livemode: input.livemode ?? false,
    account: input.account,
    type: input.type,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: input.object },
  };
}

/** A v2 thin event notification about a v2 Account. */
export function stripeThinAccountEvent(input: {
  type: string;
  accountId: string;
  livemode?: boolean;
  id?: string;
  created?: string;
}): Record<string, unknown> {
  return {
    id: input.id ?? `evt_test_thin_${++eventCounter}`,
    object: 'v2.core.event',
    type: input.type,
    livemode: input.livemode ?? false,
    created: input.created ?? new Date().toISOString(),
    context: null,
    reason: null,
    related_object: {
      id: input.accountId,
      type: 'v2.core.account',
      url: `/v2/core/accounts/${input.accountId}`,
    },
  };
}

export interface RecordedStripeRequest {
  method: string;
  /** Path without the query string, e.g. `/v1/checkout/sessions`. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** Form fields (v1) flattened as `a[b][0]`, or the parsed JSON body (v2). */
  body: Record<string, unknown>;
}

export type StripeStubHandler = (
  request: RecordedStripeRequest,
) => unknown | { status: number; body: unknown } | Promise<unknown>;

export interface StripeHttpStub {
  httpClient: Stripe.HttpClient;
  requests: RecordedStripeRequest[];
  /** Answer `METHOD /path` (path may end in `/*` to match an id segment). */
  on(route: string, handler: StripeStubHandler): StripeHttpStub;
}

interface StatusReply {
  status: number;
  body: unknown;
}
const isStatusReply = (value: unknown): value is StatusReply =>
  typeof value === 'object' &&
  value !== null &&
  'status' in value &&
  typeof (value as { status: unknown }).status === 'number' &&
  'body' in value;

/** An in-process fake of Stripe's HTTP API for adapter tests. Unmatched calls answer 404. */
export function createStripeHttpStub(): StripeHttpStub {
  const routes: Array<{ method: string; pattern: RegExp; handler: StripeStubHandler }> = [];
  const requests: RecordedStripeRequest[] = [];

  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const target = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body: Record<string, unknown> = headers['content-type']?.includes('json')
      ? raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {}
      : Object.fromEntries(new URLSearchParams(raw));
    const request: RecordedStripeRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: target.pathname,
      query: target.searchParams,
      headers,
      body,
    };
    requests.push(request);
    const route = routes.find((r) => r.method === request.method && r.pattern.test(request.path));
    const reply = route
      ? await route.handler(request)
      : {
          status: 404,
          body: {
            error: {
              type: 'invalid_request_error',
              message: `No stub for ${request.method} ${request.path}`,
            },
          },
        };
    const { status, payload } = isStatusReply(reply)
      ? { status: reply.status, payload: reply.body }
      : { status: 200, payload: reply };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': `req_stub_${requests.length}` },
    });
  }) as typeof fetch;

  const stub: StripeHttpStub = {
    httpClient: Stripe.createFetchHttpClient(fakeFetch),
    requests,
    on(route, handler) {
      const [method, path] = route.split(' ');
      const escaped = (path ?? '')
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\*|\*/g, '[^/]+');
      routes.push({
        method: (method ?? 'GET').toUpperCase(),
        pattern: new RegExp(`^${escaped}$`),
        handler,
      });
      return stub;
    },
  };
  return stub;
}
