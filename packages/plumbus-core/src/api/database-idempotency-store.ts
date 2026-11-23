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
import type { AuthContext } from '../types/security.js';
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

import { REQUEST_IDEMPOTENCY_TABLE } from './idempotency-schema.js';

export { REQUEST_IDEMPOTENCY_TABLE };

const DEFAULT_LEASE_MS = 60_000;
/** Kept this long when the route declares no `ttl`. */
const DEFAULT_TTL_MS = 86_400_000;
const SWEEP_INTERVAL_MS = 3_600_000;
/** When a sweep stopped at its cap with expired rows left, the next one may start this soon. */
const SWEEP_BACKLOG_INTERVAL_MS = 60_000;
const DEFAULT_SWEEP_BATCH_SIZE = 1000;
const DEFAULT_SWEEP_MAX_BATCHES = 50;
const DEFAULT_SWEEP_MAX_DURATION_MS = 5_000;

/** What `resolveDatabase` is told about one request's key. */
export interface IdempotencyDatabaseRequest {
  /** Whose key it is (`userId`, `tenantId`). */
  principal: IdempotencyPrincipal;
  /** The caller's auth context, when the route passes it (the core `/api` routes do). */
  auth?: AuthContext;
  /** The request's database: where the capability's own transaction runs. */
  database: PostgresJsDatabase;
  /** Whether `database` is the control plane or a tenant plane. */
  plane: 'spine' | 'tenant';
}

/** Where `resolveDatabase` puts one request's key. */
export interface IdempotencyDatabaseTarget {
  database: PostgresJsDatabase;
  /** Selects the schema (`tenantSchema` / `spineSchema`) unless `schema` names one. */
  plane: 'spine' | 'tenant';
  /** Schema of `request_idempotency` on `database`. Default: the plane's schema. */
  schema?: string;
  /**
   * Called once when the store is done with the request's key (its completion or release
   * was written, or the claim was refused): give back what the resolution holds, such as a
   * data-plane lease.
   */
  release?: () => void;
}

export interface DatabaseIdempotencyStoreOptions {
  /**
   * Where a request's key is kept. Default: the request's database (`options.database`, the
   * database the route runs the capability's transaction on). A host whose request
   * repositories live on the control plane while tenant work runs on per-tenant databases
   * returns the tenant's plane here, so stored responses — tenant-private content included —
   * stay on that tenant's database instead of the control plane. Return `undefined` for the
   * default. A throw refuses the request.
   *
   * Called once per request that presents a key, before the claim; the target (and its
   * `release`) is held until the store has written the completion or the release. When the
   * target is not the request's database the completion cannot join the capability's
   * transaction: it is written right after the capability returns (`complete`), and a crash
   * between the capability's commit and that write lets a retry run the capability again once
   * the claim's lease lapses — the window a capability without a transaction always has.
   */
  resolveDatabase?: (
    request: IdempotencyDatabaseRequest,
  ) => IdempotencyDatabaseTarget | undefined | Promise<IdempotencyDatabaseTarget | undefined>;
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
  /**
   * How often the store sweeps expired records on each database it has seen (default one
   * hour). The sweep starts beside a claim and is never awaited by the request. A sweep that
   * stopped at its cap with expired rows left lets the next one start after a minute.
   */
  sweepIntervalMs?: number;
  /** Bounds of one sweep (defaults: 1000 rows per statement, 50 statements, 5 s). */
  sweep?: Pick<IdempotencySweepOptions, 'batchSize' | 'maxBatches' | 'maxDurationMs'>;
}

export interface IdempotencySweepOptions {
  /** Schema of the table (`undefined` → unqualified, the spine). */
  schemaName?: string;
  /** Rows deleted per statement (default 1000). */
  batchSize?: number;
  /** Statements per sweep (default 50). */
  maxBatches?: number;
  /** Stop starting new statements after this long (default 5000 ms). */
  maxDurationMs?: number;
  /**
   * The former single-statement form: at most `limit` rows, one statement. Used only when
   * neither `batchSize` nor `maxBatches` is given.
   */
  limit?: number;
}

interface IdempotencySweepResult {
  deleted: number;
  /** False when the sweep stopped at `maxBatches` or `maxDurationMs` with expired rows left. */
  drained: boolean;
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
 * in batches of `batchSize` through the `expires_at` index until none is left, or until
 * `maxBatches` statements or `maxDurationMs` have been spent. The store runs it on each
 * database at most once per `sweepIntervalMs`; a host may also schedule it. A record a claim
 * renews while the sweep runs is never deleted (each statement re-checks the expiry and skips
 * locked rows). Returns how many rows were deleted.
 */
export async function sweepExpiredIdempotencyRecords(
  db: PostgresJsDatabase,
  options: IdempotencySweepOptions = {},
): Promise<number> {
  return (await sweepIdempotencyBatches(db, options)).deleted;
}

async function sweepIdempotencyBatches(
  db: PostgresJsDatabase,
  options: IdempotencySweepOptions,
): Promise<IdempotencySweepResult> {
  const table = qualifyTable(options.schemaName, REQUEST_IDEMPOTENCY_TABLE);
  const legacySingle =
    options.limit !== undefined &&
    options.batchSize === undefined &&
    options.maxBatches === undefined;
  const batchSize = Math.max(1, options.batchSize ?? options.limit ?? DEFAULT_SWEEP_BATCH_SIZE);
  const maxBatches = legacySingle
    ? 1
    : Math.max(1, options.maxBatches ?? DEFAULT_SWEEP_MAX_BATCHES);
  const deadline = Date.now() + (options.maxDurationMs ?? DEFAULT_SWEEP_MAX_DURATION_MS);
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = asRows(
      await db.execute(sql`
        DELETE FROM ${sql.raw(table)}
        WHERE key_hash IN (
          SELECT key_hash FROM ${sql.raw(table)}
          WHERE expires_at < now()
          ORDER BY expires_at
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
          AND expires_at < now()
        RETURNING key_hash
      `),
    );
    deleted += rows.length;
    if (rows.length < batchSize) return { deleted, drained: true };
    if (Date.now() >= deadline) break;
  }
  return { deleted, drained: false };
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
  const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  /** When the next sweep may start on each database. */
  const nextSweepAt = new WeakMap<object, number>();

  interface Target {
    database: PostgresJsDatabase;
    table: string;
    schemaName: string | undefined;
    release?: () => void;
  }

  /** Targets resolved at claim time, by claim token, until the completion or release. */
  const held = new Map<string, Target>();

  function requestDatabase(storeOptions: IdempotencyStoreOptions | undefined): PostgresJsDatabase {
    const database = storeOptions?.database;
    if (!database) {
      throw new PlumbusError(
        ErrorCode.Internal,
        'The database idempotency store needs the request database (options.database)',
        { reason: 'idempotency-database-missing' },
      );
    }
    return database;
  }

  function targetOf(
    database: PostgresJsDatabase,
    plane: 'spine' | 'tenant' | undefined,
    schema?: string,
    release?: () => void,
  ): Target {
    const schemaName = schema ?? (plane === 'tenant' ? tenantSchema : options.spineSchema);
    return {
      database,
      table: qualifyTable(schemaName, REQUEST_IDEMPOTENCY_TABLE),
      schemaName,
      ...(release ? { release } : {}),
    };
  }

  /** The default target: the request's database. */
  function target(storeOptions: IdempotencyStoreOptions | undefined): Target {
    const token = storeOptions?.claimToken;
    const claimed = token ? held.get(token) : undefined;
    if (claimed) return claimed;
    return targetOf(requestDatabase(storeOptions), storeOptions?.plane);
  }

  /** Ask the host where this request's key goes (default: the request's database). */
  async function resolveTarget(
    principal: IdempotencyPrincipal,
    storeOptions: IdempotencyStoreOptions | undefined,
  ): Promise<Target> {
    const database = requestDatabase(storeOptions);
    const plane = storeOptions?.plane ?? 'spine';
    if (!options.resolveDatabase) return targetOf(database, storeOptions?.plane);
    const resolved = await options.resolveDatabase({
      principal,
      ...(storeOptions?.auth ? { auth: storeOptions.auth } : {}),
      database,
      plane,
    });
    if (!resolved) return targetOf(database, storeOptions?.plane);
    return targetOf(resolved.database, resolved.plane, resolved.schema, resolved.release);
  }

  /** The store is done with this request's key: give back what its resolution holds. */
  function settle(storeOptions: IdempotencyStoreOptions | undefined): void {
    const token = storeOptions?.claimToken;
    if (!token) return;
    const claimed = held.get(token);
    held.delete(token);
    claimed?.release?.();
  }

  /** Start a sweep beside the request when one is due; the request never waits for it. */
  function sweepWhenDue(database: PostgresJsDatabase, schemaName: string | undefined): void {
    if (Date.now() < (nextSweepAt.get(database) ?? 0)) return;
    // Held off until this sweep ends, so one database never runs two sweeps at once.
    nextSweepAt.set(database, Number.POSITIVE_INFINITY);
    void sweepIdempotencyBatches(database, { ...options.sweep, schemaName }).then(
      (result) =>
        nextSweepAt.set(
          database,
          Date.now() +
            (result.drained
              ? sweepIntervalMs
              : Math.min(sweepIntervalMs, SWEEP_BACKLOG_INTERVAL_MS)),
        ),
      (error) => {
        nextSweepAt.set(database, Date.now() + sweepIntervalMs);
        options.onSweepError?.(error);
      },
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
    const resolved = await resolveTarget(principal, storeOptions);
    let result: IdempotencyClaimResult;
    try {
      result = await claimOn(resolved, key, payloadHash, principal, ttlOf(storeOptions));
    } catch (error) {
      resolved.release?.();
      throw error;
    }
    if (result.status === 'new' && result.token) held.set(result.token, resolved);
    else resolved.release?.();
    return result;
  }

  async function claimOn(
    resolved: Target,
    key: string,
    payloadHash: string,
    principal: IdempotencyPrincipal,
    ttlMs: number,
  ): Promise<IdempotencyClaimResult> {
    const { database, table, schemaName } = resolved;
    sweepWhenDue(database, schemaName);
    const keyHash = sha256(key);
    const payloadDigest = sha256(payloadHash);
    const token = randomUUID();
    const lease = `${leaseMs} milliseconds`;
    const ttl = `${Math.max(ttlMs, leaseMs)} milliseconds`;
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
      return claimOn(resolved, key, payloadHash, principal, ttlMs);
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
      // A key kept on another database than the capability's transaction cannot commit with
      // it: say so, and the caller writes the completion once the capability has returned.
      if (target(storeOptions).database !== storeOptions?.database) return false;
      if (!(await finish(tx, key, result, storeOptions))) throw new IdempotencyClaimLostError();
      return true;
    },

    async complete(key, result, storeOptions) {
      // Outside a business transaction (the capability has none, or the key is kept on another
      // database): written after the fact. A crash before this statement leaves the claim to
      // lapse, and a retry runs again.
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

    release(_key, storeOptions) {
      settle(storeOptions);
    },
  };
}
