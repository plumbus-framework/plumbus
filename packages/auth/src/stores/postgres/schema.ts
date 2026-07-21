import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: text('application_id').notNull(),
    sessionRef: text('session_ref').notNull(),
    sessionIdHash: text('session_id_hash').notNull(),
    userLookup: text('user_lookup').notNull(),
    principalEnvelope: text('principal_envelope').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('auth_sessions_application_session_id_hash_idx').on(
      table.applicationId,
      table.sessionIdHash,
    ),
    uniqueIndex('auth_sessions_application_session_ref_idx').on(
      table.applicationId,
      table.sessionRef,
    ),
    index('auth_sessions_application_user_created_idx').on(
      table.applicationId,
      table.userLookup,
      table.createdAt,
    ),
    index('auth_sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export const authLoginTransactions = pgTable(
  'auth_login_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: text('application_id').notNull(),
    stateHash: text('state_hash').notNull(),
    browserBindingHash: text('browser_binding_hash').notNull(),
    providerId: text('provider_id').notNull(),
    payloadEnvelope: text('payload_envelope').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('auth_login_transactions_application_state_hash_idx').on(
      table.applicationId,
      table.stateHash,
    ),
    index('auth_login_transactions_application_binding_created_idx').on(
      table.applicationId,
      table.browserBindingHash,
      table.createdAt,
    ),
    index('auth_login_transactions_expires_at_idx').on(table.expiresAt),
  ],
);
