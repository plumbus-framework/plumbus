import type { AuthAdapter, AuditWriter, HttpAuthenticationRuntime } from '@plumbus/core';
import { createCompositeRequestAuthenticator } from '@plumbus/core';
import type { FastifyInstance } from 'fastify';
import { assertSameSiteDeployment } from '../config/same-site.js';
import type { AuthRuntimeConfig, NormalizedAuthRuntimeConfig } from '../config/types.js';
import { validateAuthRuntimeConfig } from '../config/validate.js';
import { createStorageProtection } from '../crypto/protection.js';
import { createLoginFlow } from '../flow/login-flow.js';
import {
  clearDiscoveryRetries,
  discoverProvider,
  resolveClientSecret,
  type DiscoveredProvider,
} from '../providers/discovery.js';
import { createProviderAvailabilityMap } from '../providers/availability.js';
import { registerAuthRoutes } from '../routes/register.js';
import { createSessionAuthenticator, createSessionManager } from '../sessions/manager.js';
import { createTransactionManager } from '../transactions/manager.js';
import { createAuthAuditEmitter } from './audit.js';
import type { AuthMetrics } from './metrics.js';
import { noopAuthMetrics } from './metrics.js';

export interface CreateAuthRuntimeOptions {
  bearer?: AuthAdapter;
  auditWriter?: AuditWriter;
  clock?: () => Date;
  metrics?: AuthMetrics;
}

export function createAuthRuntime(
  config: AuthRuntimeConfig,
  opts?: CreateAuthRuntimeOptions,
): HttpAuthenticationRuntime {
  const normalized = validateAuthRuntimeConfig(config);
  const availability = createProviderAvailabilityMap(Object.keys(normalized.providers));
  const discovered = new Map<string, DiscoveredProvider>();
  const clientSecrets = new Map<string, string>();
  let protection: Awaited<ReturnType<typeof createStorageProtection>> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const clock = opts?.clock ?? (() => new Date());
  const metrics = opts?.metrics ?? noopAuthMetrics;

  const audit = createAuthAuditEmitter({
    writer: opts?.auditWriter ?? config.auditWriter,
    onFailure: () => metrics.onAuditFailure?.(),
  });

  let sessions: ReturnType<typeof createSessionManager> | undefined;
  let loginFlow: ReturnType<typeof createLoginFlow> | undefined;

  let authenticator = createCompositeRequestAuthenticator({
    bearer: opts?.bearer,
    session: {
      async authenticate() {
        return { status: 'anonymous' };
      },
    },
  });

  return {
    get authenticator() {
      return authenticator;
    },

    async initialize() {
      protection = await createStorageProtection(normalized.storageProtection, {
        applicationId: normalized.applicationId,
        environment: normalized.environment,
      });

      for (const [id, provider] of Object.entries(normalized.providers)) {
        const secret = await resolveClientSecret(provider.clientSecret);
        if (!secret) {
          throw new Error(`Provider "${id}" client secret is empty`);
        }
        clientSecrets.set(id, secret);
      }

      assertSameSiteDeployment(normalized.applicationBaseUrl, normalized.externalBaseUrl, {
        assumeSameSite: normalized.deployment.assumeSameSite,
      });

      sessions = createSessionManager({
        config: normalized,
        store: normalized.sessionStore,
        protection,
        clock,
        onSessionEvicted: (count) => {
          for (let i = 0; i < count; i++) {
            void audit.emit('auth.session.replaced', { reason: 'session_cap' });
            metrics.onSessionEvent?.('replaced');
          }
        },
      });

      const transactions = createTransactionManager({
        config: normalized,
        store: normalized.transactionStore,
        protection,
      });

      loginFlow = createLoginFlow({
        config: normalized,
        transactions,
        sessions,
        getDiscovered: (providerId) => discovered.get(providerId),
        resolveClientSecret: async (providerId) => clientSecrets.get(providerId) ?? '',
        clock,
      });

      await Promise.all(
        Object.entries(normalized.providers).map(async ([id, provider]) => {
          const start = Date.now();
          const result = await discoverProvider(id, provider, {
            environment: normalized.environment,
            fetchTimeoutMs: normalized.providerFetchTimeoutMs,
            clientSecret: clientSecrets.get(id) ?? '',
            availability,
          });
          metrics.onDiscoveryProbe?.(id, Boolean(result), Date.now() - start);
          if (result) {
            discovered.set(id, result);
          }
        }),
      );

      sweepTimer = setInterval(() => {
        const now = clock();
        void normalized.sessionStore.deleteExpired(now);
        void normalized.transactionStore.deleteExpired(now);
      }, 60_000);
      sweepTimer.unref?.();

      authenticator = createCompositeRequestAuthenticator({
        bearer: opts?.bearer,
        session: createSessionAuthenticator(sessions, clock),
      });
    },

    registerRoutes(app: FastifyInstance) {
      if (!sessions || !loginFlow) {
        throw new Error('Auth runtime not initialized');
      }
      registerAuthRoutes(app, {
        config: normalized,
        availability,
        getDiscovered: (providerId) => discovered.get(providerId),
        loginFlow,
        sessions,
        resolveClientSecret: async (providerId) => clientSecrets.get(providerId) ?? '',
        emitAudit: (event, metadata) => audit.emit(event, metadata),
        clock,
      });
    },

    async close() {
      if (sweepTimer) clearInterval(sweepTimer);
      clearDiscoveryRetries();
    },

    describeHealth() {
      const providers = availability.snapshot();
      const allAvailable = Object.values(providers).every((state) => state === 'available');
      return {
        status: allAvailable ? 'ok' : 'degraded',
        providers,
      };
    },
  };
}

export type { NormalizedAuthRuntimeConfig };
