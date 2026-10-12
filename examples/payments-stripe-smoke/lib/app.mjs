// A minimal "app" around @plumbus/payments: in-memory data, one demo seller,
// the real webhook route on Fastify, and an inline worker that runs
// payments.processProviderEvent as soon as the route queues an event (the
// production worker does the same from the outbox).
import { randomUUID } from 'node:crypto';
import {
  buildCapabilityRuntimeDeps,
  CapabilityRegistry,
  createExecutionContext,
  createPayments,
  executeCapability,
  Fastify,
  paymentsServiceAuth,
  registerPaymentRoutes,
} from './deps.mjs';

export const SELLER = { userId: 'demo-seller', tenantId: 'demo-tenant', roles: ['seller'] };

export function paymentsConfig(provider, baseUrl, overrides = {}) {
  return {
    provider,
    seller: { owner: 'user' },
    access: { sellers: { roles: ['seller'] } },
    dashboards: { full: true },
    countries: { default: 'US' },
    platformFee: { percent: 5 },
    urls: {
      onboardingReturn: `${baseUrl}/seller/return`,
      onboardingRefresh: `${baseUrl}/seller/refresh`,
      checkoutSuccess: `${baseUrl}/paid/{chargeId}`,
      checkoutCancel: `${baseUrl}/cancelled/{chargeId}`,
    },
    ...overrides,
  };
}

/** Just enough of a Plumbus repository for the payments entities (no SQL, no tenant filter). */
function memoryRepo() {
  const rows = new Map();
  const matches = (row, query = {}) => Object.entries(query).every(([k, v]) => row[k] === v);
  return {
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async findMany(query, options = {}) {
      let list = [...rows.values()].filter((row) => matches(row, query));
      if (options.orderBy === 'createdAt') {
        list.sort((a, b) => (options.orderDir === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
      }
      if (options.offset) list = list.slice(options.offset);
      if (options.limit) list = list.slice(0, options.limit);
      return list;
    },
    async create(data) {
      const row = { ...data, id: data.id ?? randomUUID(), createdAt: new Date(), updatedAt: new Date() };
      rows.set(row.id, row);
      return row;
    },
    async update(id, updates) {
      const row = { ...rows.get(id), ...updates, updatedAt: new Date() };
      rows.set(id, row);
      return row;
    },
  };
}

export async function buildApp({ provider, baseUrl = 'http://localhost:3000', overrides, log = () => {} }) {
  const payments = createPayments(paymentsConfig(provider, baseUrl, overrides));
  const data = Object.fromEntries(payments.entities.map((entity) => [entity.name, memoryRepo()]));
  const registry = new CapabilityRegistry();
  registry.registerAll(Object.values(payments.capabilities));
  const runtime = buildCapabilityRuntimeDeps(registry);
  const emitted = [];
  const pending = [];

  // Events are captured; the internal "event received" event runs the worker step inline.
  const events = {
    async emit(eventName, payload) {
      emitted.push({ eventName, payload });
      if (eventName === 'payments.provider.eventReceived') {
        pending.push(runWorker(payload));
      } else if (eventName.startsWith('payments.')) {
        log(`event ${eventName} ${JSON.stringify(payload)}`);
      }
    },
    async emitMany(list) {
      for (const e of list) await events.emit(e.eventName, e.payload);
    },
  };
  const audit = { async record() {} };
  const logger = { debug() {}, info() {}, warn: (m) => log(`warn ${m}`), error: (m) => log(`error ${m}`) };

  const routeConfig = {
    createDependencies: (auth) => ({ auth, data, events, audit, logger, ...runtime }),
  };
  const contextFor = (auth) => createExecutionContext(routeConfig.createDependencies(auth));

  async function runWorker(payload) {
    const row = await data.PaymentProviderEvent.findById(payload.ledgerId);
    const ctx = contextFor(paymentsServiceAuth(row?.tenantId ?? undefined));
    const result = await executeCapability(payments.capabilities.processProviderEvent, ctx, payload);
    if (!result.success) log(`worker failed: ${result.error.message}`);
  }

  const app = Fastify();
  registerPaymentRoutes(app, routeConfig, payments);

  async function run(name, input, auth = SELLER) {
    const ctx = contextFor({ ...auth, scopes: [], provider: 'demo' });
    const result = await executeCapability(payments.capabilities[name], ctx, input);
    if (!result.success) {
      const err = new Error(result.error.message);
      err.code = result.error.code;
      err.metadata = result.error.metadata;
      throw err;
    }
    return result.data;
  }

  async function settle() {
    while (pending.length) await pending.shift();
  }

  return {
    payments,
    app,
    run,
    settle,
    emitted: (name) => emitted.filter((e) => e.eventName === name).map((e) => e.payload),
    ledger: () => data.PaymentProviderEvent.findMany({}),
  };
}
