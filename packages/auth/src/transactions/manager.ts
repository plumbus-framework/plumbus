import { createHash, randomBytes } from 'node:crypto';
import { randomToken } from '../crypto/random.js';
import type { NormalizedAuthRuntimeConfig } from '../config/types.js';
import type { StorageProtection } from '../crypto/protection.js';
import type { AuthLoginApplicationContext } from '../resolvers/types.js';
import type { LoginTransactionStore } from '../stores/types.js';
import { buildBindingCookieHeader, readBindingCookie } from './binding-cookie.js';

export interface LoginTransactionPayload {
  state: string;
  nonce: string;
  pkceVerifier: string;
  returnTo: string;
  providerParams: Record<string, string>;
  applicationContext?: AuthLoginApplicationContext;
}

function pkceVerifier(): string {
  return randomBytes(48).toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export { pkceChallenge };

export interface TransactionManager {
  createTransaction(input: {
    providerId: string;
    returnTo: string;
    providerParams: Record<string, string>;
    applicationContext?: AuthLoginApplicationContext;
    bindingRaw: string;
    now: Date;
  }): Promise<{ state: string; nonce: string; codeChallenge: string; bindingCookie?: string }>;
  consumeTransaction(input: {
    state: string;
    bindingRaw: string;
    providerId: string;
    now: Date;
  }): Promise<LoginTransactionPayload | null>;
}

export function createTransactionManager(opts: {
  config: NormalizedAuthRuntimeConfig;
  store: LoginTransactionStore;
  protection: StorageProtection;
}): TransactionManager {
  const { config, store, protection } = opts;

  return {
    async createTransaction(input) {
      const count = await store.countForBinding({
        applicationId: config.applicationId,
        browserBindingHash: protection.hmac('binding-hmac', input.bindingRaw),
      });
      if (count >= config.transactions.maxOutstandingPerBrowser) {
        await store.evictOldestForBinding({
          applicationId: config.applicationId,
          browserBindingHash: protection.hmac('binding-hmac', input.bindingRaw),
          keep: config.transactions.maxOutstandingPerBrowser - 1,
        });
      }

      const state = randomToken();
      const nonce = randomToken();
      const pkceVerifierValue = pkceVerifier();
      const stateHash = protection.hmac('state-hmac', state);
      const recordRef = stateHash;
      const payloadEnvelope = protection.sealJson('login-transaction', 1, recordRef, {
        state,
        nonce,
        pkceVerifier: pkceVerifierValue,
        returnTo: input.returnTo,
        providerParams: input.providerParams,
        ...(input.applicationContext ? { applicationContext: input.applicationContext } : {}),
      } satisfies LoginTransactionPayload);

      await store.create({
        applicationId: config.applicationId,
        stateHash,
        browserBindingHash: protection.hmac('binding-hmac', input.bindingRaw),
        providerId: input.providerId,
        payloadEnvelope,
        schemaVersion: 1,
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + config.transactions.ttlMs),
      });

      return {
        state,
        nonce,
        codeChallenge: pkceChallenge(pkceVerifierValue),
      };
    },

    async consumeTransaction(input) {
      const consumed = await store.consume({
        applicationId: config.applicationId,
        stateHash: protection.hmac('state-hmac', input.state),
        browserBindingHash: protection.hmac('binding-hmac', input.bindingRaw),
        providerId: input.providerId,
        now: input.now,
      });
      if (!consumed) return null;

      const payload = protection.openJson(
        'login-transaction',
        1,
        consumed.stateHash,
        consumed.payloadEnvelope,
      ) as LoginTransactionPayload;

      const { constantTimeEqual } = await import('../crypto/lookup.js');
      if (!constantTimeEqual(payload.state, input.state)) {
        return null;
      }
      return payload;
    },
  };
}

export function resolveBindingRaw(
  cookies: Readonly<Record<string, string>>,
  config: NormalizedAuthRuntimeConfig,
): { bindingRaw: string; setCookie?: string } {
  const existing = readBindingCookie(cookies, config.environment);
  if (existing) {
    return { bindingRaw: existing };
  }
  const bindingRaw = randomToken();
  const maxAgeSeconds = Math.ceil(config.transactions.ttlMs / 1000);
  return {
    bindingRaw,
    setCookie: buildBindingCookieHeader(config, bindingRaw, maxAgeSeconds),
  };
}
