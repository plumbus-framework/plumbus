// ── Capability Error Hook ──
// Payload and fire-and-forget dispatch for `onCapabilityError`, shared by
// HTTP routes and the worker (flow steps, jobs, event handlers).

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { logHookError } from '../errors/hook-log.js';

/** Passed to `onCapabilityError` when a capability returns a non-success result. */
export interface CapabilityErrorInfo {
  capabilityName: string;
  domain: string;
  errorCode: string;
  errorMessage: string;
  metadata?: Record<string, unknown>;
  userId?: string;
  tenantId?: string;
  /** Client IP — HTTP only. */
  sourceIp?: string;
  /** HTTP User-Agent — HTTP only. */
  userAgent?: string;
  db?: PostgresJsDatabase;
  /** Where the capability ran: an HTTP route, a flow step, a job, or an event handler. */
  source?: 'http' | 'flow' | 'job' | 'event';
}

/**
 * Call the hook without awaiting it. Sync throws and rejections are logged,
 * never rethrown, so the hook cannot change the response or worker outcome.
 */
export function fireCapabilityErrorHook(
  hook: ((info: CapabilityErrorInfo) => void | Promise<void>) | undefined,
  info: CapabilityErrorInfo,
): void {
  if (!hook) return;
  // IIFE so a sync throw inside the hook is caught by .catch.
  void (async () => hook(info))().catch((hookErr) => {
    logHookError('onCapabilityError', hookErr);
  });
}
