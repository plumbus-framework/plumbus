// ── Database idempotency store ──
// `Idempotency-Key` records in a framework table on the database the request's capability
// writes to: the spine (`request_idempotency`) for control-plane requests, the tenant's data
// plane (`<framework schema>.request_idempotency`) for tenant requests. Shared by every
// process, so a retry that lands on another copy replays instead of running again.
//
// Claim: a short committed insert (`in-progress`, a lease). Completion: written inside the
// capability's business transaction when it has one, so the business effect and the stored
// answer commit together or not at all. A retry while the claim is live gets 409 with
// Retry-After; once the lease lapses with no completion, the business transaction did not
// commit and the request runs again.

import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { FRAMEWORK_SCHEMA } from '../data/schema-generator.js';
import { qualifyTable } from '../durable/apply-ddl.js';
import { PlumbusError } from '../errors/index.js';
import { ErrorCode } from '../types/enums.js';
import type {
  IdempotencyClaimResult,
  IdempotencyPrincipal,
  IdempotencyStore,
  IdempotencyStoreOptions,
} from './idempotency.js';

/** The framework table on every plane. */
export const REQUEST_IDEMPOTENCY_TABLE = 'request_idempotency';

const DEFAULT_LEASE_MS = 60_000;
/** Kept this long when the route declares no `ttl`. */
const DEFAULT_TTL_MS = 86_400_000;
const SWEEP_INTERVAL_MS = 3_600_000;

export interface DatabaseIdempotencyStoreOptions {
  /**
   * How long a claim holds the key before a retry may run the request again (default 60 s).
   * Make it longer than the slowest idempotent capability: a request still running when its
   * lease lapses can be overtaken by a retry, and then its own completion is refused and its
   * transaction rolled back.
   */
  leaseMs?: number;
  /** Retention when the route declares no `api.idempotency.ttl` (default 24 h). */
  defaultTtlMs?: number;
  /** Schema of the table on tenant data planes. Default the framework schema (`core_plumbus`). */
  tenantSchema?: string;
  /** Schema of the table on the spine. Default unqualified (`search_path`, normally `public`). */
  spineSchema?: string;
  /** Receives sweep failures (default: silent). */
  onSweepError?: (error: unknown) => void;
}

/** Thrown inside the business transaction when another request took the claim over. */
export class IdempotencyClaimLostError extends PlumbusError {
  constructor() {
    super(
      ErrorCode.Conflict,
      'Idempotency key was taken over by a retry while this request ran; it was rolled back',
      { reason: 'idempotency-claim-lost' },
    );
    this.name = 'IdempotencyClaimLostError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asRows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

/** `CREATE TABLE IF NOT EXISTS` for one plane; `schemaName` undefined → unqualified (spine). */
export function requestIdempotencyDdl(schemaName?: string): string {
  const table = qualifyTable(schemaName, REQUEST_IDEMPOTENCY_TABLE);
  const index = `${REQUEST_IDEMPOTENCY_TABLE}_expires_idx`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
      key_hash text PRIMARY KEY,
      principal_id text NOT NULL,
      tenant_scope text NOT NULL,
      payload_hash text NOT NULL,
      state text NOT NULL,
      claim_token uuid,
      lease_expires_at timestamptz,
      response jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      expires_at timestamptz NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS ${index} ON ${table} (expires_at);`,
  ].join('\n');
}

/**
 * Delete expired records (completed past their TTL, abandoned claims past theirs) on one plane,
 * at most `limit` per call. The store runs it on each database at most once an hour; a host
 * may also schedule it. Returns how many rows were deleted.
 */
export async function sweepExpiredIdempotencyRecords(
  db: PostgresJsDatabase,
  options: { schemaName?: string; limit?: number } = {},
): Promise<number> {
  const table = qualifyTable(options.schemaName, REQUEST_IDEMPOTENCY_TABLE);
  const rows = asRows(
    await db.execute(sql`
      DELETE FROM ${sql.raw(table)}
      WHERE key_hash IN (
        SELECT key_hash FROM ${sql.raw(table)}
        WHERE expires_at < now()
        LIMIT ${options.limit ?? 1000}
      )
      RETURNING key_hash
    `),
  );
  return rows.length;
}

/**
 * The database-backed `IdempotencyStore`. Pass it as `createServer({ idempotencyStore })` or
 * export it from `app/server.ts` (`export const idempotencyStore`); `@plumbus/api` routes use
 * the server's store unless given their own. The table must exist on every plane a request
 * can write to: `requestIdempotencyDdl()` / `migrations/spine` on the spine,
 * `requestIdempotencyDdl('core_plumbus')` / `migrations/durable-tenant` on tenant planes.
 */
export function createDatabaseIdempotencyStore(
  options: DatabaseIdempotencyStoreOptions = {},
): IdempotencyStore {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  const tenantSchema = options.tenantSchema ?? FRAMEWORK_SCHEMA;
  const lastSweepAt = new WeakMap<object, number>();

  function target(storeOptions: IdempotencyStoreOptions | undefined): {
    database: PostgresJsDatabase;
    table: string;
    schemaName: string | undefined;
  } {
    const database = storeOptions?.database;
    if (!database) {
      throw new PlumbusError(
        ErrorCode.Internal,
        'The database idempotency store needs the request database (options.database)',
        { reason: 'idempotency-database-missing' },
      );
    }
    const schemaName = storeOptions?.plane === 'tenant' ? tenantSchema : options.spineSchema;
    return { database, table: qualifyTable(schemaName, REQUEST_IDEMPOTENCY_TABLE), schemaName };
  }

  function sweepWhenDue(database: PostgresJsDatabase, schemaName: string | undefined): void {
    const last = lastSweepAt.get(database) ?? 0;
    if (Date.now() - last < SWEEP_INTERVAL_MS) return;
    lastSweepAt.set(database, Date.now());
    void sweepExpiredIdempotencyRecords(database, { schemaName }).catch((error) =>
      options.onSweepError?.(error),
    );
  }

  const ttlOf = (storeOptions?: IdempotencyStoreOptions) => storeOptions?.ttlMs ?? defaultTtlMs;

  /** Mark this request's claim completed; false when the claim is no longer this request's. */
  async function finish(
    executor: PostgresJsDatabase,
    key: string,
    result: unknown,
    storeOptions: IdempotencyStoreOptions | undefined,
  ): Promise<boolean> {
    const token = storeOptions?.claimToken;
    if (!token) return false;
    const { table } = target(storeOptions);
    const response = JSON.stringify({ v: result === undefined ? null : result });
    const rows = asRows(
      await executor.execute(sql`
        UPDATE ${sql.raw(table)}
        SET state = 'completed',
            response = ${response}::jsonb,
            completed_at = now(),
            lease_expires_at = NULL,
            expires_at = now() + ${`${ttlOf(storeOptions)} milliseconds`}::interval
        WHERE key_hash = ${sha256(key)}
          AND state = 'in-progress'
          AND claim_token = ${token}::uuid
        RETURNING key_hash
      `),
    );
    return rows.length > 0;
  }

  async function claim(
    key: string,
    payloadHash: string,
    principal: IdempotencyPrincipal,
    storeOptions: IdempotencyStoreOptions | undefined,
  ): Promise<IdempotencyClaimResult> {
    const { database, table, schemaName } = target(storeOptions);
    sweepWhenDue(database, schemaName);
    const keyHash = sha256(key);
    const payloadDigest = sha256(payloadHash);
    const token = randomUUID();
    const lease = `${leaseMs} milliseconds`;
    const ttl = `${Math.max(ttlOf(storeOptions), leaseMs)} milliseconds`;
    // One committed statement: a new key, an expired record, or an abandoned claim of the
    // same request becomes this request's claim; anything else is left as it is.
    const claimed = asRows(
      await database.execute(sql`
          INSERT INTO ${sql.raw(table)} AS existing (
            key_hash, principal_id, tenant_scope, payload_hash, state, claim_token,
            lease_expires_at, expires_at
          ) VALUES (
            ${keyHash}, ${principal.userId ?? ''}, ${principal.tenantId ?? 'spine'},
            ${payloadDigest}, 'in-progress', ${token}::uuid,
            now() + ${lease}::interval, now() + ${ttl}::interval
          )
          ON CONFLICT (key_hash) DO UPDATE SET
            principal_id = EXCLUDED.principal_id,
            tenant_scope = EXCLUDED.tenant_scope,
            payload_hash = EXCLUDED.payload_hash,
            state = 'in-progress',
            claim_token = EXCLUDED.claim_token,
            lease_expires_at = EXCLUDED.lease_expires_at,
            response = NULL,
            completed_at = NULL,
            created_at = now(),
            expires_at = EXCLUDED.expires_at
          WHERE existing.expires_at < now()
             OR (
               existing.state = 'in-progress'
               AND existing.lease_expires_at < now()
               AND existing.payload_hash = EXCLUDED.payload_hash
             )
          RETURNING claim_token::text AS claim_token
        `),
    );
    if (claimed[0]?.claim_token === token) return { status: 'new', token };

    const current = asRows(
      await database.execute(sql`
          SELECT principal_id, tenant_scope, payload_hash, state, response,
                 greatest(0, ceil(extract(epoch FROM lease_expires_at - now())))::int
                   AS retry_after
          FROM ${sql.raw(table)}
          WHERE key_hash = ${keyHash}
        `),
    )[0];
    if (!current) {
      // Swept between the two statements: claim again.
      return claim(key, payloadHash, principal, storeOptions);
    }
    if (
      current.principal_id !== (principal.userId ?? '') ||
      current.tenant_scope !== (principal.tenantId ?? 'spine')
    ) {
      return { status: 'conflict', reason: 'principal' };
    }
    if (current.payload_hash !== payloadDigest) {
      return { status: 'conflict', reason: 'payload' };
    }
    if (current.state === 'completed') {
      const stored = current.response as { v?: unknown } | null;
      return {
        status: 'replay',
        record: { payloadHash, result: stored?.v ?? null, principal },
      } satisfies IdempotencyClaimResult;
    }
    return {
      status: 'in-progress',
      retryAfterSeconds: Math.max(1, Number(current.retry_after ?? 1)),
    };
  }

  return {
    kind: 'database',
    claim,

    async completeInTransaction(tx, key, result, storeOptions) {
      if (!(await finish(tx, key, result, storeOptions))) throw new IdempotencyClaimLostError();
    },

    async complete(key, result, storeOptions) {
      // Outside a business transaction (the capability has none): written after the fact. A
      // crash before this statement leaves the claim to lapse, and a retry runs again.
      await finish(target(storeOptions).database, key, result, storeOptions);
    },

    async abort(key, storeOptions) {
      const token = storeOptions?.claimToken;
      if (!token) return;
      const { database, table } = target(storeOptions);
      // The request failed: release the key at once so the caller may retry.
      await database.execute(sql`
        DELETE FROM ${sql.raw(table)}
        WHERE key_hash = ${sha256(key)}
          AND state = 'in-progress'
          AND claim_token = ${token}::uuid
      `);
    },
  };
}
