import type { ExecutionContext } from '@plumbus/core';

type McpTaskRepository = {
  create: (data: Record<string, unknown>) => Promise<unknown>;
  update: (id: string, updates: Record<string, unknown>) => Promise<unknown>;
  findById: (id: string) => Promise<unknown | null>;
  findMany: (query?: Record<string, unknown>, options?: { limit?: number }) => Promise<unknown[]>;
};

function mcpTaskRepo(ctx: ExecutionContext): McpTaskRepository {
  const repo = (ctx.data as Record<string, McpTaskRepository | undefined>).McpTask;
  if (!repo) {
    throw new Error('McpTask entity not registered — add mcpTaskEntity to the app entity list');
  }
  return repo;
}

export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpTaskRow {
  id: string;
  userId: string;
  capabilityName: string;
  capabilityDomain: string;
  status: McpTaskStatus;
  statusMessage?: string;
  payloadJson?: unknown;
  errorJson?: unknown;
  lastProgressJson?: unknown;
  progressToken?: string;
  ttlMs?: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function createTask(
  ctx: ExecutionContext,
  input: {
    id: string;
    userId: string;
    capabilityName: string;
    capabilityDomain: string;
    progressToken?: string;
    ttlMs?: number;
  },
): Promise<McpTaskRow> {
  const now = new Date();
  const row = (await mcpTaskRepo(ctx).create({
    ...input,
    status: 'working' as const,
    createdAt: now,
    updatedAt: now,
  })) as McpTaskRow;
  return {
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt : now,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : now,
  };
}

export async function markStatus(
  ctx: ExecutionContext,
  id: string,
  status: McpTaskStatus,
  extras?: { statusMessage?: string; payloadJson?: unknown; errorJson?: unknown },
): Promise<void> {
  await mcpTaskRepo(ctx).update(id, {
    status,
    ...extras,
    updatedAt: new Date(),
  });
}

export async function recordProgress(
  ctx: ExecutionContext,
  id: string,
  progress: { progress: number; total?: number; message?: string },
): Promise<void> {
  await mcpTaskRepo(ctx).update(id, {
    lastProgressJson: progress,
    updatedAt: new Date(),
  });
}

export async function getByIdScoped(
  ctx: ExecutionContext,
  id: string,
): Promise<McpTaskRow | undefined> {
  const row = await mcpTaskRepo(ctx).findById(id);
  return row === null ? undefined : (row as McpTaskRow);
}
