// ── request_idempotency (Drizzle) ──
// The `Idempotency-Key` table of the database store, as a Drizzle table, so an application's
// generated migrations (`plumbus migrate generate`) create it in the framework schema on every
// database they are applied to — the spine and each tenant plane, including an app's own tenant
// migration stream. Same columns and index as `requestIdempotencyDdl()`.

import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tableBuilderFor } from '../data/schema-generator.js';

/** The table name on every plane. */
export const REQUEST_IDEMPOTENCY_TABLE = 'request_idempotency';

/** `request_idempotency` in `schemaName`, or unqualified when none is given. */
export function createRequestIdempotencyTable(schemaName?: string) {
  const table = tableBuilderFor(schemaName);
  return table(
    REQUEST_IDEMPOTENCY_TABLE,
    {
      keyHash: text('key_hash').primaryKey(),
      principalId: text('principal_id').notNull(),
      tenantScope: text('tenant_scope').notNull(),
      payloadHash: text('payload_hash').notNull(),
      state: text('state').notNull(),
      claimToken: uuid('claim_token'),
      leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
      response: jsonb('response'),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
      completedAt: timestamp('completed_at', { withTimezone: true }),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (t: any) => [index(`${REQUEST_IDEMPOTENCY_TABLE}_expires_idx`).on(t.expiresAt)],
  );
}
