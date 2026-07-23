import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ConsumedLoginTransaction, LoginTransactionStore } from '../types.js';
import { authLoginTransactions } from './schema.js';

function mapRow(row: typeof authLoginTransactions.$inferSelect): ConsumedLoginTransaction {
  return {
    applicationId: row.applicationId,
    stateHash: row.stateHash,
    browserBindingHash: row.browserBindingHash,
    providerId: row.providerId,
    payloadEnvelope: row.payloadEnvelope,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export function createPostgresLoginTransactionStore(db: PostgresJsDatabase): LoginTransactionStore {
  return {
    async create(record) {
      await db.insert(authLoginTransactions).values({
        applicationId: record.applicationId,
        stateHash: record.stateHash,
        browserBindingHash: record.browserBindingHash,
        providerId: record.providerId,
        payloadEnvelope: record.payloadEnvelope,
        schemaVersion: record.schemaVersion,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      });
    },
    async consume(q) {
      const deleted = await db
        .delete(authLoginTransactions)
        .where(
          and(
            eq(authLoginTransactions.applicationId, q.applicationId),
            eq(authLoginTransactions.stateHash, q.stateHash),
            eq(authLoginTransactions.browserBindingHash, q.browserBindingHash),
            eq(authLoginTransactions.providerId, q.providerId),
            gt(authLoginTransactions.expiresAt, q.now),
          ),
        )
        .returning();
      const row = deleted[0];
      return row ? mapRow(row) : null;
    },
    async countForBinding(q) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(authLoginTransactions)
        .where(
          and(
            eq(authLoginTransactions.applicationId, q.applicationId),
            eq(authLoginTransactions.browserBindingHash, q.browserBindingHash),
          ),
        );
      return rows[0]?.count ?? 0;
    },
    async evictOldestForBinding(q) {
      const rows = await db
        .select({ id: authLoginTransactions.id })
        .from(authLoginTransactions)
        .where(
          and(
            eq(authLoginTransactions.applicationId, q.applicationId),
            eq(authLoginTransactions.browserBindingHash, q.browserBindingHash),
          ),
        )
        .orderBy(asc(authLoginTransactions.createdAt));
      const overflow = rows.slice(0, Math.max(0, rows.length - q.keep));
      if (overflow.length === 0) return 0;
      const deleted = await db
        .delete(authLoginTransactions)
        .where(
          inArray(
            authLoginTransactions.id,
            overflow.map((row) => row.id),
          ),
        )
        .returning({ id: authLoginTransactions.id });
      return deleted.length;
    },
    async deleteExpired(now) {
      const deleted = await db
        .delete(authLoginTransactions)
        .where(lte(authLoginTransactions.expiresAt, now))
        .returning({ id: authLoginTransactions.id });
      return deleted.length;
    },
  };
}
