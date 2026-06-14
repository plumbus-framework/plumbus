import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  ErrorCode,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListTasksRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestInfo as McpRequestInfo } from '@modelcontextprotocol/sdk/types.js';
import {
  JobExecutionSource,
  createExecutionContext,
  dispatchQueuedJob,
  executeCapability,
  getCanonicalCapabilityName,
  type AuthContext,
  type CapabilityContract,
  type ExecutionContext,
} from '@plumbus/core';
import { buildMcpManifest, isMcpExposed } from '@plumbus/core/mcp';
import {
  createTask,
  getByIdScoped,
  markStatus,
  recordProgress,
  type McpTaskRow,
} from './tasks/task-store.js';
import type { McpServerConfig } from './types.js';

const PACKAGE_VERSION: string = (() => {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const pkg = requireFromHere('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * Maps active taskId → its AbortController for cooperative cancellation.
 *
 * Known limitation: module-scope shared across every `createMcpServer(...)`
 * instance in the process. Acceptable for the single-process / pinned-LB
 * topology that is currently the only supported deployment. Multi-instance
 * servers must add a per-`Server` registry (passed via closure or attached
 * to the Server object) — tracked as a follow-up; do NOT change in this plan.
 */
const taskAbortRegistry = new Map<string, AbortController>();

export interface CreateMcpServerOptions {
  name?: string;
  version?: string;
}

/** Case-insensitive header lookup; returns first string match or undefined. */
function getHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}

function capabilityResultToToolResponse(result: Awaited<ReturnType<typeof executeCapability>>): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  if (result.success) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.data) }],
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.error) }],
    isError: true,
  };
}

type McpExtra = {
  signal?: AbortSignal;
  authInfo?: AuthInfo;
  requestInfo?: McpRequestInfo;
};

async function resolveCtx(
  config: McpServerConfig,
  extra: McpExtra,
  options: { bypassTenantScope?: boolean } = {},
): Promise<{ ctx: ExecutionContext; authContext: AuthContext }> {
  const headerValue = getHeaderValue(extra.requestInfo?.headers, 'authorization');
  const rawToken = extra.authInfo?.token ?? headerValue;
  const authHeader = rawToken && !rawToken.startsWith('Bearer ') ? `Bearer ${rawToken}` : rawToken;
  const auth = await config.authAdapter.authenticate(authHeader);
  const authContext: AuthContext = auth ?? {
    userId: undefined,
    roles: [],
    scopes: [],
    provider: 'anonymous',
  };
  const deps = config.createDependencies(authContext, options);
  const userAgent = getHeaderValue(extra.requestInfo?.headers, 'user-agent');
  if (userAgent !== undefined) deps.request = { userAgent };
  const ctx = createExecutionContext(deps);
  return { ctx, authContext };
}

function taskRowToWire(task: McpTaskRow): {
  taskId: string;
  status: McpTaskRow['status'];
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
} {
  return {
    taskId: task.id,
    status: task.status,
    statusMessage: task.statusMessage,
    createdAt: task.createdAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    ttl: task.ttlMs ?? null,
  };
}

function assertTaskOwnership(task: McpTaskRow, auth: AuthContext): void {
  if (task.userId !== auth.userId) {
    throw new McpError(ErrorCode.InvalidRequest, 'task.forbidden: task belongs to another user');
  }
}

/** Create an MCP server that lists and invokes MCP-exposed capabilities. */
export function createMcpServer(
  config: McpServerConfig,
  options: CreateMcpServerOptions = {},
): Server {
  const server = new Server(
    { name: options.name ?? 'plumbus-mcp', version: options.version ?? PACKAGE_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const manifest = buildMcpManifest(config.registry);
    return {
      tools: manifest.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    const cap = config.registry.get(toolName);
    if (!cap || !isMcpExposed(cap)) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ code: 'not_found', message: 'Tool not found' }) },
        ],
        isError: true,
      };
    }

    const bypassTenantScope = cap.access?.tenantScoped === false;
    const { ctx, authContext } = await resolveCtx(config, extra as McpExtra, { bypassTenantScope });

    const meta = request.params._meta as
      | { taskMetadata?: unknown; progressToken?: string | number }
      | undefined;
    const taskMetadata = meta?.taskMetadata;
    const progressToken = meta?.progressToken;

    // ── Task-augmented path: kind:'job' + opt-in via taskMetadata ──
    if (cap.kind === 'job' && taskMetadata !== undefined) {
      if (!authContext.userId) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                code: 'unauthorized',
                message: 'Tasks require an authenticated user',
              }),
            },
          ],
          isError: true,
        };
      }
      const taskId = crypto.randomUUID();
      const abortController = new AbortController();
      taskAbortRegistry.set(taskId, abortController);

      const task = await createTask(ctx, {
        id: taskId,
        userId: authContext.userId,
        capabilityName: getCanonicalCapabilityName(cap),
        capabilityDomain: cap.domain,
        progressToken: progressToken !== undefined ? String(progressToken) : undefined,
      });

      if (config.jobQueue) {
        try {
          await dispatchQueuedJob({
            db: config.db,
            jobQueue: config.jobQueue,
            capability: cap as CapabilityContract,
            input: (request.params.arguments ?? {}) as Record<string, unknown>,
            auth: authContext,
            jobId: taskId,
            source: JobExecutionSource.Mcp,
            correlationId: taskId,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(taskRowToWire(task)) }],
          };
        } catch (err) {
          await markStatus(ctx, taskId, 'failed', {
            errorJson: {
              code: 'dispatch_failed',
              message: err instanceof Error ? err.message : String(err),
            },
          }).catch(() => {});
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  code: 'dispatch_failed',
                  message: err instanceof Error ? err.message : String(err),
                }),
              },
            ],
            isError: true,
          };
        }
      }

      const bgDeps = config.createDependencies(authContext, { bypassTenantScope });
      const bgCtx = createExecutionContext(bgDeps);
      bgCtx.signal = abortController.signal;
      bgCtx.progress = {
        report: (opts) => {
          void recordProgress(bgCtx, taskId, opts).catch(() => {});
          if (progressToken !== undefined) {
            void server
              .notification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: opts.progress,
                  total: opts.total,
                  message: opts.message,
                },
              })
              .catch(() => {});
          }
        },
      };

      const taskStart = Date.now();
      void (async () => {
        let finalStatus: 'success' | 'error' = 'success';
        let finalErrorCode: string | undefined;
        try {
          const result = await executeCapability(
            cap as CapabilityContract,
            bgCtx,
            request.params.arguments ?? {},
          );
          if (abortController.signal.aborted) {
            finalStatus = 'error';
            finalErrorCode = 'cancelled';
            return;
          }
          if (result.success) {
            await markStatus(bgCtx, taskId, 'completed', { payloadJson: result.data });
          } else {
            finalStatus = 'error';
            finalErrorCode = result.error.code;
            await markStatus(bgCtx, taskId, 'failed', { errorJson: result.error });
          }
        } catch (err) {
          finalStatus = 'error';
          finalErrorCode = 'internal';
          try {
            await markStatus(bgCtx, taskId, 'failed', {
              errorJson: {
                code: 'internal',
                message: err instanceof Error ? err.message : String(err),
              },
            });
          } catch {
            /* swallow — best-effort */
          }
        } finally {
          taskAbortRegistry.delete(taskId);
          if (config.onMcpToolCall) {
            void (async () =>
              config.onMcpToolCall?.({
                capabilityName: getCanonicalCapabilityName(cap),
                domain: cap.domain,
                durationMs: Date.now() - taskStart,
                status: finalStatus,
                errorCode: finalErrorCode,
                userId: authContext.userId,
                tenantId: authContext.tenantId,
                provider: authContext.provider,
              }))().catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[plumbus:mcp] onMcpToolCall hook threw (task path): ${msg}`);
            });
          }
          try {
            const finalTask = await getByIdScoped(bgCtx, taskId);
            if (finalTask) {
              await server
                .notification({
                  method: 'notifications/tasks/status',
                  params: taskRowToWire(finalTask),
                })
                .catch(() => {});
            }
          } catch {
            /* best-effort notification */
          }
        }
      })();

      return {
        task: {
          taskId,
          status: task.status,
          createdAt: task.createdAt.toISOString(),
          lastUpdatedAt: task.updatedAt.toISOString(),
          ttl: task.ttlMs ?? null,
        },
      };
    }

    // ── Inline (synchronous) path: unchanged behavior + onMcpToolCall hook ──
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const signals: AbortSignal[] = [];
    if ((extra as McpExtra).signal) signals.push((extra as McpExtra).signal as AbortSignal);
    if (config.requestTimeoutMs && config.requestTimeoutMs > 0) {
      const timeoutController = new AbortController();
      timeoutId = setTimeout(() => timeoutController.abort(), config.requestTimeoutMs);
      signals.push(timeoutController.signal);
    }
    if (signals.length === 1) {
      ctx.signal = signals[0];
    } else if (signals.length > 1) {
      ctx.signal = AbortSignal.any(signals);
    }

    const start = Date.now();
    try {
      const result = await executeCapability(
        cap as CapabilityContract,
        ctx,
        request.params.arguments ?? {},
      );
      const durationMs = Date.now() - start;

      if (config.onMcpToolCall) {
        void (async () =>
          config.onMcpToolCall?.({
            capabilityName: getCanonicalCapabilityName(cap),
            domain: cap.domain,
            durationMs,
            status: result.success ? 'success' : 'error',
            errorCode: result.success ? undefined : result.error.code,
            userId: ctx.auth.userId,
            tenantId: ctx.auth.tenantId,
            provider: ctx.auth.provider,
          }))().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[plumbus:mcp] onMcpToolCall hook threw: ${msg}`);
        });
      }

      if (!result.success && config.onCapabilityError) {
        void (async () =>
          config.onCapabilityError?.({
            capabilityName: getCanonicalCapabilityName(cap),
            domain: cap.domain,
            errorCode: result.error.code,
            errorMessage: result.error.message,
            metadata: result.error.metadata,
            userId: ctx.auth.userId,
            tenantId: ctx.auth.tenantId,
          }))().catch(() => {
          /* fire-and-forget */
        });
      }

      return capabilityResultToToolResponse(result);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  });

  server.setRequestHandler(GetTaskRequestSchema, async (request, extra) => {
    const { ctx, authContext } = await resolveCtx(config, extra as McpExtra);
    const task = await getByIdScoped(ctx, request.params.taskId);
    if (!task) throw new McpError(ErrorCode.InvalidRequest, 'task.not_found');
    assertTaskOwnership(task, authContext);
    return taskRowToWire(task);
  });

  server.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
    const { ctx, authContext } = await resolveCtx(config, extra as McpExtra);
    const task = await getByIdScoped(ctx, request.params.taskId);
    if (!task) throw new McpError(ErrorCode.InvalidRequest, 'task.not_found');
    assertTaskOwnership(task, authContext);
    if (task.status !== 'completed') {
      throw new McpError(ErrorCode.InvalidRequest, `task.not_completed: status is ${task.status}`);
    }
    return (task.payloadJson ?? {}) as Record<string, unknown>;
  });

  server.setRequestHandler(CancelTaskRequestSchema, async (request, extra) => {
    const { ctx, authContext } = await resolveCtx(config, extra as McpExtra);
    const task = await getByIdScoped(ctx, request.params.taskId);
    if (!task) throw new McpError(ErrorCode.InvalidRequest, 'task.not_found');
    assertTaskOwnership(task, authContext);
    if (task.status === 'working') {
      await markStatus(ctx, task.id, 'cancelled');
      const controller = taskAbortRegistry.get(task.id);
      if (controller) controller.abort();
    }
    const updated = await getByIdScoped(ctx, request.params.taskId);
    return taskRowToWire(updated ?? task);
  });

  server.setRequestHandler(ListTasksRequestSchema, async (_request, extra) => {
    const { ctx, authContext } = await resolveCtx(config, extra as McpExtra);
    const mcpTaskData = ctx.data as Record<
      string,
      { findMany: (q?: Record<string, unknown>, o?: { limit?: number }) => Promise<unknown[]> }
    >;
    const mcpTask = mcpTaskData.McpTask;
    if (!mcpTask) {
      throw new McpError(ErrorCode.InvalidRequest, 'McpTask entity not registered');
    }
    const rows = (await mcpTask.findMany(
      { userId: authContext.userId },
      { limit: 100 },
    )) as McpTaskRow[];
    return {
      tasks: rows.map(taskRowToWire),
    };
  });

  return server;
}
