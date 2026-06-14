# Upgrading to Workers and Queues (0.5.0)

This guide covers migration from pre-0.5.0 Plumbus runtimes to the unified workers and queues model.

**Topology is backward compatible:** `plumbus dev` and `plumbus start` without env overrides still default to `PLUMBUS_RUNTIME_ROLE=all` (API + workers colocated). **Some app-visible behavior changes** apply even at that default — see [Breaking and behavior changes](#breaking-and-behavior-changes) below.

## What Changed

| Area | Before | After (0.5.0) |
|------|--------|---------------|
| Runtime layout | API + implicit background work in one process | Explicit runtime roles (`all`, `api`, `worker`) |
| Queues | Single events queue concept | Three queues: `events`, `flows`, `jobs` |
| Job capabilities | Fire-and-forget via events queue | `job_executions` table + dedicated jobs queue + `GET /api/jobs/:id` |
| `eventHandler` wiring | Manual `ConsumerRegistry` in `app/server.ts` | Auto-registration when `trigger.event` is set |
| MCP `kind: 'job'` tasks | In-process execution only | Optional `jobQueue` on `McpServerConfig` for shared worker dequeue |
| Production scaling | Single replica assumed | Split `api` + `worker` replicas with Redis |
| Framework tables | 9 internal tables | 10 — adds `job_executions` |
| Optional peers | `@plumbus/mcp`, `@plumbus/api` | Adds optional `redis`, `cron-parser` |

## Compatible-Minor Migration Checklist

Work through these steps in order. Skip steps that do not apply to your app.

### 1. Run migrations

The `job_executions` table is new. Generate and apply migrations before deploying the new runtime:

```bash
plumbus migrate generate
plumbus migrate apply
```

If your database already has the correct schema but migration history is missing, use `plumbus migrate reconcile` instead.

### 2. Install optional dependencies (production)

For any deployment with more than one API or worker replica, or with scheduled flows:

```bash
pnpm add redis
pnpm add cron-parser   # only if flows use schedule triggers
```

Without `redis`, the runtime falls back to in-memory queues with a startup warning. This is fine for `plumbus dev` but **not** for multi-replica production.

### 3. Review `eventHandler` capabilities

Add `trigger.event` to capabilities that should auto-register:

```typescript
defineCapability({
  name: "onOrderPlaced",
  kind: "eventHandler",
  trigger: { event: "order.placed" },  // ← add this
  // ...
});
```

Run `plumbus verify` to surface handlers still missing `trigger.event`. If you intentionally register consumers manually in `app/server.ts`, no change is required — manual registrations take precedence.

### 4. Update HTTP job clients (required if you call job routes)

If your frontend or integrations call `POST` routes for `kind: 'job'` capabilities, they must handle **202** and poll the status endpoint (pre-0.5.0 often received **200** with the handler output synchronously):

```
GET /api/jobs/:jobId
```

The `202` response body is `{ data: { jobId, status: "accepted" } }` (standard Plumbus envelope). `GET /api/jobs/:jobId` returns `{ data: { jobId, status, output, error, … } }` with statuses including `queued`, `running`, `completed`, `failed`, and `dead_lettered`.

Job routes insert into `job_executions` before enqueueing — deploy migrations **before** traffic hits job endpoints or requests will fail at the database layer.

### 5. Choose a runtime topology

**No change needed** if a single `plumbus start` process is sufficient (default `PLUMBUS_RUNTIME_ROLE=all`).

**Split when scaling horizontally:**

```bash
# API deployment
PLUMBUS_RUNTIME_ROLE=api
npx plumbus start --port 3000

# Worker deployment
npx plumbus worker start --health-port 3001
```

Configure Redis (`QUEUE_URL` or `REDIS_URL`) on both deployments.

### 6. Wire MCP `jobQueue` (split deployments only)

If you run `plumbus mcp serve` separately from workers and expose `kind: 'job'` capabilities, configure Redis so `resolveRuntimeQueues` returns `isDurable: true`, then pass the shared jobs queue to `createMcpServer`:

```typescript
const queues = await resolveRuntimeQueues(config);
// only when queues.isDurable
jobQueue: queues.jobs,
```

`plumbus mcp serve` wires this automatically when Redis is configured. Without Redis, MCP jobs execute in-process. **HTTP and MCP differ:** colocated `plumbus start` / `plumbus dev` wire `jobQueue` for HTTP whenever job capabilities exist (in-memory or Redis), so job `POST` routes return **202** even without Redis. MCP receives `jobQueue` only when Redis is durable (`queues.isDurable`). See [MCP Tasks and Jobs](./mcp/tasks-and-jobs.md#shared-jobs-queue).

### 7. Add worker health probes (split deployments)

Worker containers expose a lightweight HTTP server (not the main API):

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness |
| `GET /ready` | Readiness (database connected) |
| `GET /metrics` | Prometheus-format metrics |

Default port: `3001` (`--health-port`).

## Environment Variables (New)

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `PLUMBUS_RUNTIME_ROLE` | `all`, `api`, `worker` | `all` for dev/start; `worker` for `plumbus worker` | Process role |
| `QUEUE_BACKEND` | `memory`, `redis` | auto-detect | Force queue backend |
| `QUEUE_URL` | Redis connection URL | — | Preferred Redis config |
| `REDIS_URL` | Alias for `QUEUE_URL` | — | Common hosting convention |

Existing `QUEUE_HOST`, `QUEUE_PORT`, and `QUEUE_PASSWORD` continue to work.

## Breaking and behavior changes

### Always review on upgrade

| Change | Who is affected | Action |
|--------|-----------------|--------|
| **`job_executions` migration** | Any deploy | `plumbus migrate generate && plumbus migrate apply` before deploy |
| **HTTP `kind: 'job'` → async 202** | Apps with job capabilities on `plumbus start`/`dev` or `PLUMBUS_RUNTIME_ROLE=api` | Pre-0.5.0: jobs ran **synchronously** (HTTP **200** + output). 0.5.0: **202** + `{ data: { jobId, status: "accepted" } }` whenever the API wires `jobQueue` (not gated on worker pool). Poll `GET /api/jobs/:jobId`. On API-only replicas, also run `plumbus worker` or jobs never execute. |
| **Broader worker pool activation** | Apps with `defineEvent`, `eventHandler`, `job`, or scheduled flows but no event-triggered flows | Background workers now start automatically (outbox dispatcher, consumers). Usually desirable; verify resource usage. |
| **Jobs queue moved off events queue** | Custom consumers listening on the events queue for job work | Subscribe to the **jobs** queue or use framework consumers |
| **`trigger` only on `eventHandler`** | Any capability | Adding `trigger` to non-`eventHandler` kinds throws at `defineCapability` time |

### Opt-in traps (split / Redis topology)

| Opt-in change | Impact |
|---------------|--------|
| `PLUMBUS_RUNTIME_ROLE=api` without a worker process | Jobs and events enqueue but never execute |
| `QUEUE_BACKEND=redis` without `redis` package installed | Falls back to in-memory with warning |
| MCP `jobQueue` / Redis without worker running | MCP tasks stay `working` until a worker dequeues |
| Duplicate manual + auto event consumers | Same event may run twice unless manual id matches capability name or manual registration is removed |

## Rollback

To roll back to pre-0.5.0 behavior:

1. Deploy the previous `@plumbus/core` version.
2. The `job_executions` table is additive — safe to leave in place; older runtimes ignore it.
3. Remove `PLUMBUS_RUNTIME_ROLE` env vars to restore colocated mode.

## See Also

- [Workers and Queues](./architecture/workers-and-queues.md) — full runtime reference
- [Upgrading capability names](./upgrading-capability-names.md) — canonical names, `effects.capabilities`, flow auth snapshot, invoke policy (same 0.5.x release)
- [CLI Commands](./cli/commands.md) — `plumbus worker`, `plumbus events`, `plumbus flow dead-letter`
- [Deployment](../packages/plumbus-core/instructions/deployment.md) — worker container templates
