import { createExecutionContext, type ContextDependencies } from '@plumbus/core';
import { errorToHttpResponse, isPlumbusError } from '@plumbus/core/errors';
import { markStatus, getByIdScoped } from './task-store.js';

/** Sync MCP task rows when shared job_executions complete in a worker process. */
export function createMcpJobCompletionSync(
  dependencies: ContextDependencies | ((tenantId?: string) => ContextDependencies),
) {
  return async (
    jobId: string,
    result: 'completed' | 'failed',
    payload?: unknown,
    error?: unknown,
    tenantId?: string | null,
  ): Promise<void> => {
    const tenant = tenantId || undefined;
    const deps = typeof dependencies === 'function' ? dependencies(tenant) : dependencies;
    const ctx = createExecutionContext({ ...deps, auth: { ...deps.auth, tenantId: tenant } });
    const task = await getByIdScoped(ctx, jobId);
    if (!task || (task.tenantId ?? undefined) !== tenant) return;
    if (result === 'completed') {
      await markStatus(ctx, jobId, 'completed', { payloadJson: payload });
    } else {
      await markStatus(ctx, jobId, 'failed', {
        errorJson: isPlumbusError(error)
          ? errorToHttpResponse(error).body.error
          : { code: 'failed', message: 'Job failed' },
      });
    }
  };
}
