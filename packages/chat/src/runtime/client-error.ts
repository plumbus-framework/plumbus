import type { ExecutionContext } from '@plumbus/core';
import { isPlumbusError } from '@plumbus/core/sdk';

/** Message sent to chat clients in place of an internal or vendor error message. */
export const CHAT_GENERIC_ERROR_MESSAGE = 'The chat turn could not be completed';

/**
 * PlumbusError codes whose message is written for the caller. Mirrors core's
 * HTTP mapping (`errorToHttpResponse`): 4xx codes keep their message,
 * `forbidden` is masked to "Access denied", `internal` is replaced.
 */
const CALLER_FACING_CODES = new Set<string>([
  'validation',
  'notFound',
  'conflict',
  'leaseLost',
  'cancelled',
  'dependencyViolation',
  'unauthorized',
]);

/**
 * Turn an error caught inside the turn pipeline into the message a client may
 * see. Raw `err.message` from providers, databases or app code can carry vendor
 * responses, SQL, hostnames or keys, so only PlumbusErrors with a caller-facing
 * code keep their message; everything else becomes a generic message and the
 * full detail goes to the server log.
 */
export function clientSafeErrorMessage(ctx: ExecutionContext, err: unknown, where: string): string {
  if (isPlumbusError(err)) {
    if (CALLER_FACING_CODES.has(err.code)) return err.message;
    if (err.code === 'forbidden') return 'Access denied';
  }
  const detail: Record<string, unknown> = {
    where,
    error: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : undefined,
    stack: err instanceof Error ? err.stack : undefined,
  };
  const logger = (ctx as { logger?: { error?: unknown } }).logger;
  if (logger && typeof logger.error === 'function') {
    (logger.error as (m: string, d: Record<string, unknown>) => void).call(
      logger,
      'chat turn failed',
      detail,
    );
  } else {
    console.error('[@plumbus/chat] chat turn failed', detail);
  }
  return CHAT_GENERIC_ERROR_MESSAGE;
}
