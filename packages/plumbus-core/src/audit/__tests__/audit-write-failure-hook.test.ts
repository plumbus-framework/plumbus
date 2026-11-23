// The host's `onAuditWriteFailure` reaches the audit services the framework builds: the
// request's (through `wireContextDependencies`) and the binding of a transaction that writes
// its kept refusals after a rollback.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it, vi } from 'vitest';
import { EntityRegistry } from '../../data/registry.js';
import { EventRegistry } from '../../events/registry.js';
import { wireContextDependencies } from '../../execution/context-deps.js';
import type { AuthContext } from '../../types/security.js';
import {
  type AuditWriteFailure,
  bindAuditServiceToTransaction,
  createAuditService,
  recordAfterEffects,
} from '../service.js';

const auth: AuthContext = { userId: 'u', roles: [], scopes: [], provider: 'test', tenantId: 't' };

/** A database whose audit inserts fail (as an unreachable audit table would). */
function failingDb(): PostgresJsDatabase {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => {
          throw new Error('audit store unreachable');
        },
      }),
    }),
  } as unknown as PostgresJsDatabase;
}

/** A database whose audit inserts succeed. */
function workingDb(): PostgresJsDatabase {
  return {
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
  } as unknown as PostgresJsDatabase;
}

describe('onAuditWriteFailure', () => {
  it('is the request audit service reporter when the host gives one', async () => {
    const failures: AuditWriteFailure[] = [];
    const deps = wireContextDependencies({
      db: failingDb(),
      auth,
      entities: new EntityRegistry(),
      events: new EventRegistry(),
      onAuditWriteFailure: (failure) => failures.push(failure),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await recordAfterEffects(deps.audit, [{ eventType: 'Invoice.create', metadata: {} }]);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.final).toBe(false);
      expect(failures[0]?.events[0]?.action).toBe('Invoice.create');
      // The hook replaces the default log line.
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps the default log line without a hook', async () => {
    const deps = wireContextDependencies({
      db: failingDb(),
      auth,
      entities: new EntityRegistry(),
      events: new EventRegistry(),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await recordAfterEffects(deps.audit, [{ eventType: 'Invoice.create', metadata: {} }]);
      expect(logged).toHaveBeenCalledWith(
        '[plumbus] audit record could not be written; retrying in the background',
        expect.anything(),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('reports a refusal record lost after a rollback through the outer service hook', async () => {
    const failures: AuditWriteFailure[] = [];
    const outer = createAuditService({
      db: failingDb(),
      auth,
      onWriteFailure: (failure) => failures.push(failure),
    });
    const binding = bindAuditServiceToTransaction(outer, workingDb());
    if (!binding) throw new Error('a default service binds');
    await binding.audit.record('Invoice.update', { outcome: 'denied' });
    await binding.rolledBack();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ final: true });
    expect(failures[0]?.events[0]).toMatchObject({ action: 'Invoice.update', outcome: 'denied' });
  });
});
