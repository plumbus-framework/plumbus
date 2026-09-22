import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createAuditService } from '../audit/service.js';
import type { EntityRegistry } from '../data/registry.js';
import { createEventEmitter } from '../events/emitter.js';
import type { EventRegistry } from '../events/registry.js';
import type { AuditService } from '../types/audit.js';
import type { ContextDependencies } from '../types/context.js';
import type { AuthContext } from '../types/security.js';
import { createTransactionRunner } from './transactional-outbox.js';

export interface WireContextDependenciesOptions {
  db: PostgresJsDatabase;
  auth: AuthContext;
  entities: EntityRegistry;
  events: EventRegistry;
  audit?: AuditService;
  bypassTenantScope?: boolean;
  correlationId?: string;
  getCausationId?: () => string | undefined;
  encryptionKey?: Buffer;
}

/**
 * Build ContextDependencies with outer-db audit, request-scoped data/events,
 * and a `withTransaction` hook for transactional outbox execution.
 */
export function wireContextDependencies(
  options: WireContextDependenciesOptions,
  extras: Partial<ContextDependencies> = {},
): ContextDependencies {
  const audit = options.audit ?? createAuditService({ db: options.db, auth: options.auth });
  const data = options.entities.createDataService({
    db: options.db,
    auth: options.auth,
    audit,
    bypassTenantScope: options.bypassTenantScope,
    encryptionKey: options.encryptionKey,
  });
  const eventService = createEventEmitter({
    db: options.db,
    auth: options.auth,
    registry: options.events,
    audit,
    correlationId: options.correlationId,
    getCausationId: options.getCausationId,
  });
  const withTransaction = createTransactionRunner({
    db: options.db,
    entities: options.entities,
    events: options.events,
    getAuth: () => options.auth,
    getAudit: () => audit,
    getCausationId: options.getCausationId,
    correlationId: options.correlationId,
    bypassTenantScope: options.bypassTenantScope,
    encryptionKey: options.encryptionKey,
  });

  return {
    auth: options.auth,
    data,
    events: eventService,
    audit,
    withTransaction,
    ...extras,
  };
}
