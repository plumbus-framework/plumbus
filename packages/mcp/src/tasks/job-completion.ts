import type { ContextDependencies } from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core/runtime';
import { markStatus } from './task-store.js';

/** Sync MCP task rows when shared job_executions complete in a worker process. */
export function createMcpJobCompletionSync(deps: ContextDependencies) {
  return async (
    jobId: string,
    result: 'completed' | 'failed',
    payload?: unknown,
    error?: unknown,
    tenantId?: string | null,
  ): Promise<void> => {
    const auth = tenantId != null && tenantId !== '' ? { ...deps.auth, tenantId } : deps.auth;
    const ctx = createExecutionContext({ ...deps, auth });
    if (result === 'completed') {
      await markStatus(ctx, jobId, 'completed', { payloadJson: payload });
    } else {
      await markStatus(ctx, jobId, 'failed', {
        errorJson:
          error && typeof error === 'object' && 'code' in error
            ? error
            : { code: 'failed', message: String(error ?? 'Job failed') },
      });
    }
  };
}
