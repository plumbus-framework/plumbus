// ── Read ceiling ──
// The most rows one repository read may hand back unless the call opts out. A read that would
// go past it is reported (`warn`) or refused (`error`); it is never cut short quietly, because
// a caller that computes on the first N rows of a larger set computes the wrong answer.
// Shared by the Drizzle repository and the in-memory test repository so both behave alike.

import { z } from 'zod';
import { DataReadCeilingError, DataValidationError } from '../errors/data-errors.js';

export const ReadCeilingMode = {
  /** Over-ceiling reads still return what they did before, and are logged with their call site. */
  Warn: 'warn',
  /** Over-ceiling reads throw `DataReadCeilingError`; the unlimited form is bounded in SQL. */
  Error: 'error',
} as const;
export type ReadCeilingMode = (typeof ReadCeilingMode)[keyof typeof ReadCeilingMode];

/** The read ceiling when the host configures nothing (`PLUMBUS_READ_CEILING`). */
export const DEFAULT_READ_CEILING = 1000;
/** Mode when the host configures nothing (`PLUMBUS_READ_CEILING_MODE`). */
export const DEFAULT_READ_CEILING_MODE: ReadCeilingMode = ReadCeilingMode.Warn;
/** A call site that keeps going over the ceiling is reported again after this long. */
const REPORT_INTERVAL_MS = 60_000;
/** Distinct call sites remembered for de-duplication before the oldest is forgotten. */
const REPORT_KEYS_MAX = 1000;

export type ReadCeilingOperation = 'findMany' | 'findManyFields' | 'aggregate' | 'findPage';

/** One read that went past the ceiling (always reported in `warn` mode). */
export interface ReadCeilingEvent {
  entity: string;
  operation: ReadCeilingOperation;
  ceiling: number;
  mode: ReadCeilingMode;
  /** The result was larger than the ceiling, or an explicit `limit` asked for more. */
  cause: 'result-over-ceiling' | 'limit-over-ceiling';
  /** Rows the read returned (`result-over-ceiling`). */
  rows?: number;
  /** The `limit` the call passed (`limit-over-ceiling`). */
  limit?: number;
  /** Stack of the calling code, to find the call site. */
  stack?: string;
  /** Further reports of the same call site folded into this one since the last report. */
  repeats?: number;
}

/** How a host bounds repository reads. */
export interface ReadCeilingPolicy {
  /**
   * Rows one read may return without `{ unbounded: true }` (a whole number ≥ 1). Past it a read
   * is refused (`error`), or returned in full and reported (`warn`).
   */
  maxRows: number;
  mode: ReadCeilingMode;
  /**
   * Receives every over-ceiling read in `warn` mode, at most once a minute per call site.
   * Default: `console.warn`. The server and worker bootstraps route it to their logger.
   */
  report?: (event: ReadCeilingEvent) => void;
}

/** What `data.*` in the app configuration says about the ceiling. */
export interface ReadCeilingConfig {
  readCeiling?: number;
  readCeilingMode?: ReadCeilingMode;
}

const modeSchema = z.enum([ReadCeilingMode.Warn, ReadCeilingMode.Error]);

/** Validate a policy and give it a de-duplicating reporter. */
export function createReadCeilingPolicy(input: Partial<ReadCeilingPolicy> = {}): ReadCeilingPolicy {
  const maxRows = input.maxRows ?? DEFAULT_READ_CEILING;
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new DataValidationError('The read ceiling must be a whole number of at least 1', {
      field: 'data.readCeiling',
      value: maxRows,
    });
  }
  const mode = modeSchema.safeParse(input.mode ?? DEFAULT_READ_CEILING_MODE);
  if (!mode.success) {
    throw new DataValidationError("The read ceiling mode must be 'warn' or 'error'", {
      field: 'data.readCeilingMode',
    });
  }
  return { maxRows, mode: mode.data, report: dedupeReports(input.report ?? reportToConsole) };
}

/** The policy a host's `data` configuration describes, reporting through `warn`. */
export function readCeilingPolicyFromConfig(
  config: ReadCeilingConfig | undefined,
  warn?: (message: string, metadata: Record<string, unknown>) => void,
): ReadCeilingPolicy {
  return createReadCeilingPolicy({
    maxRows: config?.readCeiling,
    mode: config?.readCeilingMode,
    ...(warn
      ? {
          report: (event: ReadCeilingEvent) =>
            warn(READ_CEILING_WARNING, event as unknown as Record<string, unknown>),
        }
      : {}),
  });
}

export const READ_CEILING_WARNING =
  'Repository read went past the read ceiling; page it, count or aggregate it in SQL, or pass { unbounded: true }';

function reportToConsole(event: ReadCeilingEvent): void {
  console.warn(`[plumbus] ${READ_CEILING_WARNING}`, event);
}

function dedupeReports(report: (event: ReadCeilingEvent) => void): (e: ReadCeilingEvent) => void {
  const seen = new Map<string, { at: number; repeats: number }>();
  return (event) => {
    const key = `${event.entity}|${event.operation}|${event.cause}|${event.stack ?? ''}`;
    const now = Date.now();
    const last = seen.get(key);
    if (last && now - last.at < REPORT_INTERVAL_MS) {
      last.repeats += 1;
      return;
    }
    seen.delete(key);
    if (seen.size >= REPORT_KEYS_MAX) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.set(key, { at: now, repeats: 0 });
    report(last && last.repeats > 0 ? { ...event, repeats: last.repeats } : event);
  };
}

/** Stack frames of this module and the repositories that call it (file paths, not text). */
const FRAMEWORK_READ_FRAME =
  /[/\\](?:data[/\\](?:read-ceiling|repository)|testing[/\\]context)\.[cm]?[jt]s:/;

/** The calling code's frames, without this module's and the repository's own. */
function callerStack(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  return stack
    .split('\n')
    .slice(1)
    .filter((line) => !FRAMEWORK_READ_FRAME.test(line))
    .slice(0, 8)
    .map((line) => line.trim())
    .join('\n');
}

/** The SQL bound of one read, and the check its result must pass. */
export interface ReadBound {
  /** LIMIT to apply; `undefined` for none. */
  sqlLimit?: number;
  /** Run on the fetched rows; returns how many of them to hand back (all, unless refused). */
  check(rowCount: number): number;
}

/**
 * Decide how one read is bounded under `policy`:
 * - `unbounded: true` → the given `limit` (or none), no check;
 * - a `limit` at or under the ceiling → exactly that limit;
 * - a `limit` over the ceiling → `error`: refused before any query; `warn`: honoured exactly
 *   and reported (whatever comes back), so `warn` reports every read `error` would refuse and
 *   never returns less than was asked for (earlier releases cut it to 100 without a word);
 * - no `limit` → `error`: LIMIT ceiling + 1, and refused if that extra row comes back;
 *   `warn`: no LIMIT (as before), reported if more rows than the ceiling came back.
 */
export function planReadBound(
  policy: ReadCeilingPolicy,
  entity: string,
  operation: ReadCeilingOperation,
  options: { limit?: number | null; unbounded?: boolean } | undefined,
): ReadBound {
  const limit = options?.limit ?? undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new DataValidationError(`limit must be a whole number of 0 or more`, {
      entity,
      operation,
      field: 'limit',
      limit,
    });
  }
  const all = (count: number) => count;
  if (options?.unbounded === true) return { sqlLimit: limit, check: all };
  const ceiling = policy.maxRows;
  if (limit !== undefined) {
    if (limit <= ceiling) return { sqlLimit: limit, check: all };
    const event: ReadCeilingEvent = {
      entity,
      operation,
      ceiling,
      mode: policy.mode,
      cause: 'limit-over-ceiling',
      limit,
    };
    if (policy.mode === ReadCeilingMode.Error) throw ceilingError(event);
    policy.report?.({ ...event, stack: callerStack() });
    return { sqlLimit: limit, check: all };
  }
  if (policy.mode === ReadCeilingMode.Error) {
    return {
      sqlLimit: ceiling + 1,
      check(count) {
        if (count > ceiling) {
          throw ceilingError({
            entity,
            operation,
            ceiling,
            mode: policy.mode,
            cause: 'result-over-ceiling',
          });
        }
        return count;
      },
    };
  }
  return {
    check(count) {
      if (count > ceiling) {
        policy.report?.({
          entity,
          operation,
          ceiling,
          mode: policy.mode,
          cause: 'result-over-ceiling',
          rows: count,
          stack: callerStack(),
        });
      }
      return count;
    },
  };
}

function ceilingError(event: ReadCeilingEvent): DataReadCeilingError {
  const what =
    event.cause === 'limit-over-ceiling'
      ? `asked for limit ${event.limit}, above`
      : 'matched more rows than';
  return new DataReadCeilingError(
    `Read of "${event.entity}" (${event.operation}) ${what} the read ceiling of ${event.ceiling} rows. ` +
      'Page it (limit + offset, or findPage), count or aggregate it in SQL, or pass { unbounded: true } ' +
      'where every row is really needed.',
    {
      entity: event.entity,
      operation: event.operation,
      ceiling: event.ceiling,
      cause: event.cause,
      ...(event.limit !== undefined ? { limit: event.limit } : {}),
    },
  );
}

// ── Keyset cursor ──

export interface KeysetKey {
  column: string;
  dir: 'asc' | 'desc';
}

/**
 * The total order of a `findPage` call: the given keys, then `id` (in the last key's
 * direction) unless the caller already sorts by it.
 */
export function resolveKeysetKeys(
  orderBy: string | Array<{ column: string; dir?: 'asc' | 'desc' }> | undefined,
  orderDir: 'asc' | 'desc' | undefined,
): KeysetKey[] {
  const fallback = orderDir ?? 'asc';
  const specs =
    orderBy === undefined
      ? []
      : typeof orderBy === 'string'
        ? [{ column: orderBy, dir: fallback }]
        : orderBy.map((s) => ({ column: s.column, dir: s.dir ?? fallback }));
  const keys: KeysetKey[] = specs.map((s) => ({ column: s.column, dir: s.dir }));
  if (!keys.some((k) => k.column === 'id')) {
    keys.push({ column: 'id', dir: keys[keys.length - 1]?.dir ?? fallback });
  }
  return keys;
}

function keysetSignature(keys: KeysetKey[]): string {
  return keys.map((k) => `${k.column}:${k.dir}`).join(',');
}

type CursorValue = string | number | boolean | { d: string };

const cursorSchema = z.object({
  k: z.string(),
  v: z.array(z.union([z.string(), z.number(), z.boolean(), z.object({ d: z.string() })])),
});

/** Encode the sort-key values of the row a page ends on. */
export function encodeKeysetCursor(
  entity: string,
  keys: KeysetKey[],
  row: Record<string, unknown>,
): string {
  const values: CursorValue[] = keys.map((key) => {
    const value = row[key.column];
    if (value instanceof Date) return { d: value.toISOString() };
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    throw new DataValidationError(
      `findPage on "${entity}" cannot continue after a row whose sort key "${key.column}" is ${
        value === null || value === undefined ? 'NULL' : 'not a string, number, boolean or date'
      }; sort by columns that are never NULL`,
      { entity, field: key.column, operation: 'findPage' },
    );
  });
  return Buffer.from(JSON.stringify({ k: keysetSignature(keys), v: values }), 'utf8').toString(
    'base64url',
  );
}

/** Decode a cursor for `keys`; a cursor of another sort, or not a cursor at all, is refused. */
export function decodeKeysetCursor(
  entity: string,
  keys: KeysetKey[],
  cursor: string,
): Array<string | number | boolean | Date> {
  let parsed: z.infer<typeof cursorSchema> | undefined;
  try {
    const result = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    parsed = result.success ? result.data : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || parsed.k !== keysetSignature(keys) || parsed.v.length !== keys.length) {
    throw new DataValidationError(
      `findPage on "${entity}": the cursor does not belong to this sort`,
      { entity, field: 'after', operation: 'findPage' },
    );
  }
  return parsed.v.map((value) => (typeof value === 'object' ? new Date(value.d) : value));
}

let sharedDefaultPolicy: ReadCeilingPolicy | undefined;

/**
 * The policy a repository uses when it is built without one (direct `createRepository` calls,
 * an `EntityRegistry` the host never configured): defaults, reporting to the console. One
 * instance per process, so its de-duplication spans every repository that uses it.
 */
export function defaultReadCeilingPolicy(): ReadCeilingPolicy {
  sharedDefaultPolicy ??= createReadCeilingPolicy();
  return sharedDefaultPolicy;
}
