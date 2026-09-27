// ── Webhook route ──
// Mounted from app/server.ts `onRoutesRegistered`. The route lives in its own
// encapsulated Fastify plugin that keeps the raw request bytes (providers sign
// the exact body) without changing JSON parsing anywhere else in the app.
//
// Order of work: verify signature → check live/test mode → find the seller
// (the only cross-tenant read, as the payments service account) → record the
// event once and queue it → 200. Processing happens in the worker, so the
// provider gets a fast answer and its retries stay harmless.

import type { RouteGeneratorConfig } from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { VerifiedProviderEvent } from '../types/provider.js';
import type { Payments } from './create-payments.js';
import { ingestProviderEvent, paymentsServiceAuth } from './ingest.js';
import { findOne, merchantAccounts } from './repos.js';

export interface RegisterPaymentRoutesOptions {
  /** Called for each verified delivery after it is recorded (metrics, logs). Errors are ignored. */
  onEvent?: (info: {
    eventId: string;
    type: string;
    status: 'received' | 'ignored' | 'duplicate';
    ignoredReason: string | null;
  }) => void;
}

export function registerPaymentRoutes(
  app: FastifyInstance,
  routeConfig: RouteGeneratorConfig,
  payments: Payments,
  options: RegisterPaymentRoutesOptions = {},
): void {
  const { provider, config } = payments;

  for (const finding of payments.findings) {
    if (finding.level === 'warning') {
      app.log.warn({ code: finding.code, path: finding.path }, `payments: ${finding.message}`);
    }
  }

  const contextFor = (tenantId?: string) => {
    const deps = routeConfig.createDependencies(paymentsServiceAuth(tenantId));
    deps.request = { userAgent: 'payments-webhook' };
    return createExecutionContext(deps);
  };
  const findSeller = (accountId: string) => {
    const deps = routeConfig.createDependencies(paymentsServiceAuth(), {
      bypassTenantScope: true,
    });
    return findOne(merchantAccounts(createExecutionContext(deps)), {
      provider: provider.id,
      providerAccountId: accountId,
    });
  };

  app.register(async (scope) => {
    scope.removeContentTypeParser(['application/json']);
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: config.webhooks.bodyLimitBytes },
      (_request, body, done) => done(null, body),
    );

    scope.post(config.webhooks.path, async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        return reply.status(400).send({ error: { code: 'invalid_body' } });
      }

      let event: VerifiedProviderEvent;
      try {
        event = await provider.verifyWebhook({
          rawBody,
          headers: request.headers as Record<string, string | string[] | undefined>,
        });
      } catch {
        request.log.warn({ provider: provider.id }, 'payments: webhook signature rejected');
        return reply.status(400).send({ error: { code: 'invalid_signature' } });
      }

      try {
        const outcome = await ingestProviderEvent({ payments, event, findSeller, contextFor });
        try {
          options.onEvent?.({
            eventId: event.eventId,
            type: event.type,
            status: outcome.duplicate ? 'duplicate' : outcome.status,
            ignoredReason: outcome.ignoredReason,
          });
        } catch {
          // Observer errors never fail the delivery.
        }
        return reply.status(200).send({ received: true });
      } catch (err) {
        request.log.error(
          { provider: provider.id, eventId: event.eventId, type: event.type },
          `payments: failed to record webhook — ${err instanceof Error ? err.message : String(err)}`,
        );
        return reply.status(500).send({ error: { code: 'internal' } });
      }
    });
  });
}
