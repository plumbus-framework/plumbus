/** D13–D20: real HTTP → Plumbus capability → provider HTTP → persisted test ledger. */
import { createServer as createHttpServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createServer } from '../../server/index.js';
import { defineCapability } from '../../define/index.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import { EntityRegistry } from '../../data/index.js';
import { EventRegistry } from '../../events/registry.js';
import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import { createTypeSafeDecisionAdapter } from '../../../../ai-decision-typesafe/src/index.js';
import { createLayaDecisionAdapter } from '../../../../ai-decision-laya/src/index.js';
import type { AICostRecord } from '../index.js';

type Provider = 'typesafe' | 'laya';
type Received = { url?: string; body: unknown; authorization?: string };
const questions = {
  p: { type: 'probability', instructions: '?' },
  team: {
    type: 'choice',
    instructions: 'Team?',
    criteria: { billing: 'Payments', support: 'Help' },
  },
  urgency: { type: 'score', instructions: 'Urgency?', criteria: ['Low', 'High'] },
} as const;
function wire() {
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 1000, output_tokens: 0 },
    routing: { model: 'english', repo: 'local-fixture', reason: 'test' },
    answers: {
      p: { type: 'noul', noul: 0.7 },
      team: {
        type: 'choice',
        choice: 'billing',
        probabilities: { billing: 0.9, support: 0.1 },
        confidence: 0.8,
      },
      urgency: {
        type: 'score',
        score: 1,
        probabilities: { 0: 0, 1: 1 },
        legend: { 0: 'Low', 1: 'High' },
        confidence: 1,
      },
    },
  };
}
function send(response: ServerResponse, body = wire()) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
async function fixture(
  providerName: Provider,
  handler: (res: ServerResponse, request: Received, attempt: number) => void,
  signal?: AbortSignal,
) {
  const dir = await mkdtemp(join(tmpdir(), 'plumbus-decision-http-'));
  const ledger = join(dir, 'ledger.jsonl');
  const requests: Received[] = [];
  const upstream = createHttpServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = {
        url: req.url,
        body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
        authorization: req.headers.authorization,
      };
      requests.push(request);
      handler(res, request, requests.length);
    })().catch(() => res.destroy());
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Expected test TCP server');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const adapter =
    providerName === 'typesafe'
      ? createTypeSafeDecisionAdapter({
          baseUrl,
          apiKey: 'synthetic-provider-key',
          maxRetries: 1,
          timeoutMs: 5000,
        })
      : createLayaDecisionAdapter({
          baseUrl,
          apiKey: 'synthetic-provider-key',
          maxRetries: 1,
          timeoutMs: 5000,
          costPerRequestUsd: 0.002,
        });
  const capabilities = new CapabilityRegistry();
  capabilities.register(
    defineCapability<z.ZodTypeAny, z.ZodTypeAny>({
      name: 'evaluate',
      domain: 'audit',
      kind: 'action',
      transactional: false,
      input: z
        .object({
          state: z.string().default('Refund please'),
          timeoutMs: z.number().optional(),
          project: z.string().default('project'),
        })
        .passthrough(),
      output: z.record(z.unknown()),
      access: { roles: ['tester'] },
      effects: { data: [], events: [], external: [], ai: true },
      audit: { enabled: false, event: 'test.decision' },
      async handler(ctx, input) {
        return {
          ...(await ctx.ai.decide({
            state: input.state,
            questions,
            timeoutMs: input.timeoutMs,
            signal: signal ?? ctx.signal,
            costContext: { projectId: input.project },
          })),
        };
      },
    }),
  );
  const app = createServer({
    config: {
      environment: 'development',
      database: { host: 'localhost', port: 5432, database: 'test', user: 'test', password: '' },
      queue: { host: 'localhost', port: 6379 },
      auth: { provider: 'test' },
    },
    db: {} as never,
    capabilities,
    entities: new EntityRegistry(),
    events: new EventRegistry(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    host: '127.0.0.1',
    port: 0,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    authAdapter: {
      async authenticate(header) {
        const tenant =
          header === 'Bearer a' ? 'tenant-a' : header === 'Bearer b' ? 'tenant-b' : undefined;
        return tenant
          ? {
              tenantId: tenant,
              userId: `${tenant}-user`,
              roles: ['tester'],
              scopes: [],
              provider: 'test',
            }
          : null;
      },
    },
    decisions: { providers: { [providerName]: adapter }, defaultProvider: providerName },
    onAICostRecorded: async (row, context) => {
      await appendFile(ledger, `${JSON.stringify({ ...row, context })}\n`);
    },
  });
  let url: string;
  try {
    url = await app.start();
  } catch (error) {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    requests,
    call: (input: Record<string, unknown> = {}, auth = 'Bearer a') =>
      fetch(`${url}/api/audit/evaluate`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10000),
      }),
    async rows(): Promise<Array<AICostRecord & { context?: { projectId?: string } }>> {
      try {
        return (await readFile(ledger, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
    async close() {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await app.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe.each(['typesafe', 'laya'] as const)('decision HTTP lifecycle (%s)', (provider) => {
  it('[D13] denies an unauthenticated capability before inference or cost recording', async () => {
    const test = await fixture(provider, (res) => send(res));
    try {
      const res = await test.call({}, 'Bearer invalid');
      expect(res.status).toBe(403);
      expect(test.requests).toHaveLength(0);
      expect(await test.rows()).toEqual([]);
    } finally {
      await test.close();
    }
  });

  it('[D14] records one successful logical call after a provider rate-limit retry', async () => {
    const test = await fixture(provider, (res, _request, attempt) => {
      if (attempt === 1) {
        res.writeHead(429, { 'retry-after-ms': '0' });
        res.end('rate limited');
      } else send(res);
    });
    try {
      expect((await test.call()).status).toBe(200);
      expect(test.requests).toHaveLength(2);
      const rows = await test.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider,
        model: 'jev-1.13.0',
        status: 'success',
        operation: 'decide',
        usage: { inputTokens: 1000 },
      });
      expect(rows[0]?.cost).toBeCloseTo(provider === 'typesafe' ? 0.000042 : 0.002, 10);
    } finally {
      await test.close();
    }
  });

  it('[D15] exhausted provider retries produce one failed, unpriced row without body leakage', async () => {
    const test = await fixture(provider, (res) => {
      res.writeHead(503, { 'retry-after-ms': '0' });
      res.end('PRIVATE UPSTREAM RESPONSE');
    });
    try {
      const res = await test.call();
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain('PRIVATE');
      expect(test.requests).toHaveLength(2);
      const rows = await test.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', cost: null });
      expect(JSON.stringify(rows)).not.toContain('PRIVATE');
    } finally {
      await test.close();
    }
  });

  it.each([
    'choice',
    'score',
  ] as const)('[D16] retains billed metadata after invalid %s output without retrying', async (kind) => {
    const test = await fixture(provider, (res) => {
      const body = wire();
      if (kind === 'choice') body.answers.team.choice = 'unrequested';
      else body.answers.urgency.score = 0;
      send(res, body);
    });
    try {
      expect((await test.call()).status).toBe(500);
      expect(test.requests).toHaveLength(1);
      const rows = await test.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'failed',
        model: 'jev-1.13.0',
        usage: { inputTokens: 1000 },
      });
      expect(rows[0]?.cost).toBeCloseTo(provider === 'typesafe' ? 0.000042 : 0.002, 10);
    } finally {
      await test.close();
    }
  });

  it('[D17] refuses redirects and never forwards the provider credential to the redirect target', async () => {
    const test = await fixture(provider, (res, request) => {
      if (request.url === '/trap') send(res);
      else {
        res.writeHead(302, { location: '/trap' });
        res.end();
      }
    });
    try {
      expect((await test.call()).status).toBe(500);
      expect(test.requests.map((request) => request.url)).toEqual(['/v1/systemone']);
      expect((await test.rows())[0]).toMatchObject({ status: 'failed', cost: null });
    } finally {
      await test.close();
    }
  });

  it('[D18] a stalled response body times out and records the failed call', async () => {
    const test = await fixture(provider, (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"model":');
    });
    try {
      expect((await test.call({ timeoutMs: 250 })).status).toBe(500);
      const rows = await test.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'failed',
        cost: null,
        errorMessage: 'Decision provider timeout',
      });
    } finally {
      await test.close();
    }
  });

  it('[D19] cancellation after dispatch settles the request and records only a failed row', async () => {
    const controller = new AbortController();
    let entered: () => void = () => {};
    const received = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const test = await fixture(
      provider,
      () => {
        entered();
      },
      controller.signal,
    );
    try {
      const pending = test.call();
      await received;
      controller.abort();
      expect((await pending).status).toBeGreaterThanOrEqual(400);
      const rows = await test.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'failed',
        cost: null,
        errorMessage: 'Decision provider cancelled',
      });
    } finally {
      controller.abort();
      await test.close();
    }
  });

  it('[D20] concurrent HTTP requests retain authenticated identities despite forged body fields', async () => {
    const test = await fixture(provider, (res) => send(res));
    try {
      const responses = await Promise.all([
        test.call({ tenantId: 'forged', actor: 'forged', project: 'a' }, 'Bearer a'),
        test.call({ tenantId: 'forged', actor: 'forged', project: 'b' }, 'Bearer b'),
      ]);
      expect(responses.map((res) => res.status)).toEqual([200, 200]);
      const rows = (await test.rows()).sort((a, b) =>
        String(a.tenantId).localeCompare(String(b.tenantId)),
      );
      expect(rows.map((row) => [row.tenantId, row.actor, row.context?.projectId])).toEqual([
        ['tenant-a', 'tenant-a-user', 'a'],
        ['tenant-b', 'tenant-b-user', 'b'],
      ]);
      expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    } finally {
      await test.close();
    }
  });
});
