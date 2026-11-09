import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * One id per HTTP request, shared by the answer, the logs and the audit trail — opt-in.
 *
 * Everything that changes an answer is off unless the server is created with
 * `requestIds: { expose: true }` (`createServer({ requestIds })`, or `export const requestIds` from
 * `app/server.ts`). Off, answers are byte-for-byte what they were before request ids existed. One
 * internal fix applies either way because it changes no answer: a correlation id a caller proposes
 * is written to the audit row only when it is well formed (below); a malformed one is dropped and
 * the context issues its own.
 *
 * With `expose: true`:
 * A person who meets a refusal or an error can read this id to whoever supports them, and that
 * person finds the same id in the server log line (Fastify's `reqId`), in the capability's audit
 * row (`correlationId`) and in `onCapabilityError` (`requestId`). Every refusal and error body a
 * capability route sends carries it as `error.requestId`, and every answer carries it in the
 * `x-request-id` response header.
 *
 * A caller may propose its own id in `x-request-id` (or `x-correlation-id`, which wins when both
 * are sent) so a proxy or a gateway can stitch its own log to ours. The proposal is used only when
 * it is well formed: 8–128 characters of letters, digits and `.`, `_`, `:`, `-`, starting with a
 * letter or digit. Anything else — empty, too long, carrying spaces, quotes or line breaks that
 * could forge a log line — is ignored and a fresh UUID is issued instead.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

const PROPOSED_ID_HEADERS = ['x-correlation-id', REQUEST_ID_HEADER] as const;

/** Request id behaviour for a server (`createServer({ requestIds })`). */
export interface RequestIdOptions {
  /**
   * Name each request's id on its answer: the `x-request-id` header, `error.requestId` in every
   * refusal and error body (including SSE error events and bodies other routes build), and
   * Fastify's `reqId` in log lines. Default `false`: answers are unchanged.
   */
  expose?: boolean;
}

const WELL_FORMED_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** Whether `value` is acceptable as a request id proposed by a caller. */
export function isWellFormedRequestId(value: unknown): value is string {
  return typeof value === 'string' && WELL_FORMED_REQUEST_ID.test(value);
}

/**
 * The request id for a set of request headers: the caller's well-formed proposal, else a new UUID.
 *
 * Pure: two calls with headers that propose nothing return two different ids. Use
 * {@link requestIdOf} wherever the same request is asked about twice.
 */
export function resolveRequestId(
  headers: Record<string, string | string[] | undefined> | undefined,
): string {
  for (const name of PROPOSED_ID_HEADERS) {
    const raw = headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (isWellFormedRequestId(value)) return value;
  }
  return randomUUID();
}

const assigned = new WeakMap<IncomingMessage, string>();

/**
 * The request id of one HTTP request, decided once and remembered for that request.
 *
 * Keyed on the raw Node request, so Fastify's `genReqId` (which sees only the raw request), the
 * capability route, the error handler and an app's own routes all read the same id.
 */
export function requestIdOf(request: IncomingMessage | { raw: IncomingMessage }): string {
  const raw = 'raw' in request && request.raw ? request.raw : (request as IncomingMessage);
  let id = assigned.get(raw);
  if (id === undefined) {
    id = resolveRequestId(raw.headers);
    assigned.set(raw, id);
  }
  return id;
}

/** `body.error` with `requestId` added, leaving every other field as it was. */
export function withRequestId<B extends { error: Record<string, unknown> }>(
  body: B,
  requestId: string,
): B & { error: { requestId: string } } {
  return { ...body, error: { ...body.error, requestId } };
}

/** The ids one capability route uses for a request (see {@link requestIdsFor}). */
export interface RouteRequestIds {
  /** Under `expose`: the request id every answer and error body names. Else `undefined`. */
  exposed?: string;
  /**
   * The id an `unauthorized` / authentication / dependency refusal echoes as `error.requestId`:
   * the exposed id, else — as before request ids were exposed — the caller's own
   * `x-correlation-id` / `x-request-id` header when it sent one.
   */
  echoed?: string;
  /**
   * The audit `correlationId`: the exposed id, else the caller's proposal only when it is well
   * formed (a malformed one could forge an audit or log line), else `undefined` so the context
   * issues its own.
   */
  correlationId?: string;
}

/** The request ids a capability route uses, given the server's {@link RequestIdOptions}. */
export function requestIdsFor(
  request: IncomingMessage | { raw: IncomingMessage; headers?: IncomingMessage['headers'] },
  options: RequestIdOptions | undefined,
): RouteRequestIds {
  if (options?.expose === true) {
    const id = requestIdOf(request);
    return { exposed: id, echoed: id, correlationId: id };
  }
  const headers =
    ('headers' in request && request.headers) ||
    ('raw' in request && request.raw ? request.raw.headers : undefined);
  const proposed = proposedRequestId(headers);
  return {
    echoed: proposed,
    correlationId: isWellFormedRequestId(proposed) ? proposed : undefined,
  };
}

/** The caller's first non-empty `x-correlation-id` / `x-request-id`, unvalidated. */
function proposedRequestId(
  headers: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  for (const name of PROPOSED_ID_HEADERS) {
    const value = headers?.[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
