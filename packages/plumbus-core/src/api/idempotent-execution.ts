// ── Idempotent capability execution ──
// The claim → execute → complete/abort sequence both HTTP surfaces (`/api` routes and
// `@plumbus/api` partner routes) run for a declared `api.idempotency`. Each surface maps the
// outcome to its own response shape.

import type {
  CapabilityResult,
  ExecuteCapabilityOptions,
} from '../execution/capability-executor.js';
import {
  IdempotencyAbortedError,
  type IdempotencyPrincipal,
  type IdempotencyStore,
  type IdempotencyStoreOptions,
} from './idempotency.js';

export type IdempotentExecutionOutcome<T> =
  /** The key completed earlier: answer with its stored result (after any re-authorization). */
  | { kind: 'replay'; result: unknown }
  /** Same key, another principal (409) or another payload (422). */
  | { kind: 'conflict'; reason: 'principal' | 'payload' }
  /** Another request holds a live claim on the key: 409 with `Retry-After`. */
  | { kind: 'in-progress'; retryAfterSeconds: number }
  /** This request ran the capability. */
  | { kind: 'executed'; result: CapabilityResult<T> };

export interface ExecuteIdempotentlyParams<T> {
  store: IdempotencyStore;
  key: string;
  payloadHash: string;
  principal: IdempotencyPrincipal;
  options?: IdempotencyStoreOptions;
  /** Runs the capability; pass the options on to `executeCapability`. */
  execute: (options: ExecuteCapabilityOptions | undefined) => Promise<CapabilityResult<T>>;
}

/**
 * Claim the key, run the capability once, and record the outcome. A store with
 * `completeInTransaction` records success inside the capability's business transaction;
 * when the capability has none (or the store cannot), success is recorded after it returned.
 * A failure or a throw releases the key so the caller may retry. An in-process wait on a
 * request that then failed claims again.
 */
export async function executeIdempotently<T>(
  params: ExecuteIdempotentlyParams<T>,
): Promise<IdempotentExecutionOutcome<T>> {
  const { store, key, payloadHash, principal } = params;
  let claim = await store.claim(key, payloadHash, principal, params.options);
  for (;;) {
    if (claim.status === 'replay') return { kind: 'replay', result: claim.record.result };
    if (claim.status === 'conflict') return { kind: 'conflict', reason: claim.reason };
    if (claim.status === 'in-progress') {
      return { kind: 'in-progress', retryAfterSeconds: claim.retryAfterSeconds };
    }
    if (claim.status === 'in-flight') {
      try {
        const record = await claim.wait;
        return { kind: 'replay', result: record.result };
      } catch (waitErr) {
        if (!(waitErr instanceof IdempotencyAbortedError)) throw waitErr;
        claim = await store.claim(key, payloadHash, principal, params.options);
        continue;
      }
    }
    break;
  }
  // From here on every store call names this request's claim.
  const options: IdempotencyStoreOptions | undefined =
    claim.token === undefined ? params.options : { ...params.options, claimToken: claim.token };

  let completedInTransaction = false;
  const completeInTransaction = store.completeInTransaction?.bind(store);
  const executeOptions: ExecuteCapabilityOptions | undefined = completeInTransaction
    ? {
        beforeCommit: async (tx, output) => {
          await completeInTransaction(tx, key, output, options);
          completedInTransaction = true;
        },
      }
    : undefined;

  let result: CapabilityResult<T>;
  try {
    result = await params.execute(executeOptions);
  } catch (execErr) {
    await store.abort(key, options);
    throw execErr;
  }
  if (result.success) {
    if (!completedInTransaction) await store.complete(key, result.data, options);
  } else {
    await store.abort(key, options);
  }
  return { kind: 'executed', result };
}
