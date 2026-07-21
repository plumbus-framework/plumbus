import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ProtectedSessionRecord, SessionStore } from '../types.js';
import { authSessions } from './schema.js';

function mapRow(row: typeof authSessions.$inferSelect): ProtectedSessionRecord {
  return {
    applicationId: row.applicationId,
    sessionRef: row.sessionRef,
    sessionIdHash: row.sessionIdHash,
    userLookup: row.userLookup,
    principalEnvelope: row.principalEnvelope,
    csrfHash: row.csrfHash,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

async function evictOverflow(
  tx: Pick<PostgresJsDatabase, 'select' | 'delete'>,
  q: { applicationId: string; userLookup: string; keep: number },
): Promise<number> {
  const rows = await tx
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.applicationId, q.applicationId),
        eq(authSessions.userLookup, q.userLookup),
      ),
    )
    .orderBy(asc(authSessions.createdAt));
  const overflow = rows.slice(0, Math.max(0, rows.length - q.keep));
  if (overflow.length === 0) {
    return 0;
  }
  const deleted = await tx
    .delete(authSessions)
    .where(
      inArray(
        authSessions.id,
        overflow.map((row) => row.id),
      ),
    )
    .returning({ id: authSessions.id });
  return deleted.length;
}

export function createPostgresSessionStore(db: PostgresJsDatabase): SessionStore {
  return {
    async create(record) {
      await db.insert(authSessions).values({
        applicationId: record.applicationId,
        sessionRef: record.sessionRef,
        sessionIdHash: record.sessionIdHash,
        userLookup: record.userLookup,
        principalEnvelope: record.principalEnvelope,
        csrfHash: record.csrfHash,
        schemaVersion: record.schemaVersion,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      });
    },
    async createWithSessionCap(record, keep) {
      return db.transaction(async (tx) => {
        await tx.insert(authSessions).values({
          applicationId: record.applicationId,
          sessionRef: record.sessionRef,
          sessionIdHash: record.sessionIdHash,
          userLookup: record.userLookup,
          principalEnvelope: record.principalEnvelope,
          csrfHash: record.csrfHash,
          schemaVersion: record.schemaVersion,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        });
        return evictOverflow(tx, {
          applicationId: record.applicationId,
          userLookup: record.userLookup,
          keep,
        });
      });
    },
    async getByIdHash(q) {
      const rows = await db
        .select()
        .from(authSessions)
        .where(
          and(
            eq(authSessions.applicationId, q.applicationId),
            eq(authSessions.sessionIdHash, q.sessionIdHash),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? mapRow(row) : null;
    },
    async deleteByIdHash(q) {
      const deleted = await db
        .delete(authSessions)
        .where(
          and(
            eq(authSessions.applicationId, q.applicationId),
            eq(authSessions.sessionIdHash, q.sessionIdHash),
          ),
        )
        .returning({ id: authSessions.id });
      return deleted.length > 0;
    },
    async deleteForUser(q) {
      const deleted = await db
        .delete(authSessions)
        .where(
          and(
            eq(authSessions.applicationId, q.applicationId),
            eq(authSessions.userLookup, q.userLookup),
          ),
        )
        .returning({ id: authSessions.id });
      return deleted.length;
    },
    async countForUser(q) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(authSessions)
        .where(
          and(
            eq(authSessions.applicationId, q.applicationId),
            eq(authSessions.userLookup, q.userLookup),
          ),
        );
      return rows[0]?.count ?? 0;
    },
    async evictOldestForUser(q) {
      return db.transaction(async (tx) => evictOverflow(tx, q));
    },
    async deleteExpired(now) {
      const deleted = await db
        .delete(authSessions)
        .where(lte(authSessions.expiresAt, now))
        .returning({ id: authSessions.id });
      return deleted.length;
    },
  };
}
