# Workers and Queues

Plumbus runs background work — event dispatch, flow execution, scheduled flows, and async job capabilities — through a **worker pool** backed by three logical queues: `events`, `flows`, and `jobs`. The API process and worker pool can run **colocated** (default) or **split** across processes for horizontal scaling.

## Runtime Modes

| Mode | How to run | Queues | Use case |
|------|------------|--------|----------|
| **In-memory colocated** (default dev) | `plumbus dev` | In-memory, API + workers in one process | Local development, single-instance tests |
| **Redis colocated** | `plumbus start` with Redis configured | Redis-backed, API + workers in one process | Small production, single replica |
| **Split API + worker** | `PLUMBUS_RUNTIME_ROLE=api` + `plumbus worker` | Shared Redis (required for multi-replica) | Production with scaled API and worker replicas |

```
┌─────────────────────────────────────────────────────────────────┐
│  Colocated (default: plumbus dev / plumbus start, role=all)     │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Single process                                           │  │
│  │  ┌─────────────┐    ┌──────────────────────────────────┐  │  │
│  │  │ Fastify API │    │ Worker pool                       │  │  │
│  │  │ /health     │    │  outbox dispatcher                │  │  │
│  │  │ /ready      │    │  event consumers                  │  │  │
│  │  │ /api/*      │    │  flow step consumer               │  │  │
│  │  │ /api/jobs/* │    │  flow scheduler (cron)            │  │  │
│  │  └─────────────┘    │  job consumers                    │  │  │
│  │                     └──────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│         │                              │                        │
│         └──────────────┬───────────────┘                        │
│                        ▼                                        │
│              ┌──────────────────┐                               │
│              │ PostgreSQL       │                               │
│              │ (outbox, jobs,   │                               │
│              │  flow state)     │                               │
│              └────────┬─────────┘                               │
│                       │                                         │
│              ┌────────▼─────────┐                               │
│              │ Redis (optional) │  ← in-memory if not configured │
│              │ events/flows/jobs│                               │
│              └──────────────────┘                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Split (PLUMBUS_RUNTIME_ROLE=api + plumbus worker)              │
│                                                                 │
│  ┌─────────────────┐         ┌─────────────────────────────┐   │
│  │ API replicas    │         │ Worker replicas              │   │
│  │ plumbus start   │         │ plumbus worker start         │   │
│  │ role=api        │         │ /health /ready /metrics      │   │
│  │ /health /ready  │         │ (no public API routes)       │   │
│  └────────┬────────┘         └──────────────┬──────────────┘   │
│           │                                  │                  │
│           └──────────────┬───────────────────┘                  │
│                          ▼                                      │
│                 ┌─────────────────┐                               │
│                 │ Redis (required)│                               │
│                 │ shared queues   │                               │
│                 └─────────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

### In-memory colocated (default)

- `plumbus dev` always uses **in-memory** queues (`preferInMemory: true`), even when Redis env vars are set. This keeps local development self-contained.
- `plumbus start` without Redis configuration uses in-memory queues. A startup warning is emitted in production/staging because in-memory queues are **single-instance only**.

### Redis colocated

Configure Redis and the runtime selects a durable backend automatically:

```bash
QUEUE_URL=redis://redis:6379
# or
REDIS_URL=redis://redis:6379
# or
QUEUE_HOST=redis
QUEUE_PORT=6379
```

Force the backend explicitly:

```bash
QUEUE_BACKEND=redis   # always Redis (falls back to in-memory if redis package missing)
QUEUE_BACKEND=memory  # always in-memory
```

Three Redis list prefixes are created from `queue.prefix` (default `plumbus:{environment}`):

- `{prefix}:events`
- `{prefix}:flows`
- `{prefix}:jobs`

### Split API + worker

For horizontal scaling, run API and worker processes separately:

```bash
# Terminal 1 — API only (no worker pool)
PLUMBUS_RUNTIME_ROLE=api npx plumbus start --port 3000

# Terminal 2 — workers only (no HTTP API)
npx plumbus worker start --health-port 3001
```

**Redis is required** when multiple API or worker replicas share work. Without Redis, each process has its own in-memory queue and jobs/events will not drain correctly across replicas.

## `PLUMBUS_RUNTIME_ROLE`

Controls which subsystems start in the current process. Valid values: `all`, `api`, `worker`.

| Value | HTTP API | Worker pool | Default when |
|-------|----------|-------------|--------------|
| `all` | Yes | Yes | `plumbus dev`, `plumbus start` (no env override) |
| `api` | Yes | No | Set explicitly for API-only replicas |
| `worker` | No | Yes | `plumbus worker` (implicit) |

```bash
PLUMBUS_RUNTIME_ROLE=api    # API-only process
PLUMBUS_RUNTIME_ROLE=worker # Worker-only process
PLUMBUS_RUNTIME_ROLE=all    # Colocated (backward compatible default)
```

When `PLUMBUS_RUNTIME_ROLE=api`, job capabilities enqueue to the shared jobs queue but **do not execute** until a worker process is running. The API process still receives `jobQueue` wiring when job capabilities exist so HTTP and MCP can publish. The same applies to outbox events and flow steps.

## What Starts the Worker Pool

The worker pool starts when **both** conditions are true:

1. Runtime role allows workers (`all` or `worker`, not `api`).
2. `needsWorkerPool()` detects background work:

| Signal | Triggers worker pool |
|--------|---------------------|
| Any `defineEvent()` in `app/events/` | Yes (outbox dispatcher) |
| Flow with `trigger.event` or `schedule` | Yes |
| `kind: 'eventHandler'` capability | Yes |
| `kind: 'job'` capability | Yes |

If none of the above exist, the worker pool is skipped (API-only apps pay no background cost).

## Queue Topology

```
Capability handler
    │
    ├── ctx.events.emit() ──▶ event_outbox (PostgreSQL, same transaction)
    │                              │
    │                              ▼
    │                     Outbox dispatcher
    │                              │
    │                              ▼
    │                     events queue ──▶ eventHandler consumers
    │                              │       flow triggers
    │                              │       manual ConsumerRegistry handlers
    │
    ├── POST job capability ──▶ job_executions row
    │                              │
    │                              ▼
    │                     jobs queue ──▶ job handler execution
    │
    └── flow trigger/schedule ──▶ flow_executions row
                                       │
                                       ▼
                              flows queue ──▶ step consumer
```

**Flow step auth:** `flow_executions.auth_snapshot_json` stores the caller's `AuthContext` at start time. Step execution restores roles/scopes from that snapshot — not from the worker's `system` auth — so user-triggered flows enforce the same access policies as the original HTTP or API caller.

All three queues share the same `EventQueue` abstraction (`createInMemoryQueue` or `createRedisQueue`). Redis queues use atomic Lua rewrap on dequeue and a single shared client quit on shutdown. Legacy processing entries without `dequeuedAt` are requeued on recovery. A configurable visibility timeout (`queue.visibilityTimeoutSec`, default 30 seconds) handles poison-message recovery.

The flow step queue consumer calls `claimExecution(executionId)` before `runNext` to prevent double execution alongside the DB poll loop.

**Delayed flow steps:** when a flow enters a delay wait with a durable Redis backend, the engine schedules wake in sorted set `{prefix}:flows:delayed` (score = `wakeAt` epoch ms). A promoter polls due entries and enqueues to the flows queue. In-memory deployments rely on the DB poll loop (`wake_at <= now`) as fallback.

## Capability Auto-Registration

At worker startup, Plumbus auto-wires queue consumers from capability contracts:

### `eventHandler` with `trigger.event`

```typescript
defineCapability({
  name: "onOrderPlaced",
  kind: "eventHandler",
  trigger: { event: "order.placed" },
  input: orderPlaced.payload, // optional — validates envelope payload
  access: { serviceAccounts: ["event-worker"] },
  handler: async (ctx, input) => { /* ... */ },
});
```

When `trigger.event` is set, the framework registers a consumer keyed by the capability name. Manual `ConsumerRegistry` registrations with the same id take precedence (auto-registration is skipped).

**Tenant binding (fail closed):** at dequeue, the worker loads the matching `event_outbox` row and uses its `tenant_id` as the authoritative tenant for the handler's service-account auth context. Envelope/queue tenant mismatches against the outbox row are rejected. Messages without a matching outbox row are **rejected** — Redis is a trust boundary and must not be treated as authoritative for tenant identity. Trusted ops replay (`plumbus events replay`, `plumbus events dead-letter retry`) sets actor `outbox-replay` or `ops-retry` and carries tenant from the outbox row or dead-letter metadata.

`plumbus verify` warns when an `eventHandler` lacks `trigger.event` (`worker.event-handler-missing-trigger`). Handlers with data/event write effects get an idempotency advisory (`worker.event-handler-side-effects`). When handler `input` and event `payload` schemas diverge, `worker.event-handler-payload-compatibility` advises alignment.

### `kind: 'job'`

Job capabilities are registered as consumers on the jobs queue. HTTP `POST` and MCP task dispatch both create a `job_executions` row and publish to the same queue.

**Security at dequeue:** the job consumer loads `job_executions` by ID, atomically claims `queued → running`, and uses `auth_snapshot_json` from the row for authorization and execution context. Queue payload `auth` is never trusted. Capability domain/name must match the row.

**Crash recovery:** if a worker dies while a job is `running`, delivery is not acknowledged. After `queue.visibilityTimeoutSec` (default 30s), another worker reclaims the stale `running` row and retries execution. Duplicate deliveries for terminal jobs (`completed`, `failed`, `dead_lettered`) are acknowledged without re-running the handler.

If queue publish fails after the DB insert, the row is marked `failed`. If delivery retries are exhausted, the row is marked `dead_lettered`.

## Job Executions

Async job capabilities persist lifecycle state in the framework `job_executions` table:

| Column | Purpose |
|--------|---------|
| `id` | Job ID returned in `202` responses and MCP task handles |
| `capability_domain`, `capability_name` | Which job capability |
| `status` | `queued`, `running`, `completed`, `failed`, `dead_lettered` |
| `input_json`, `output_json`, `error_json` | Payload snapshots |
| `auth_snapshot_json` | Caller identity at enqueue time |
| `source` | `http`, `mcp`, `flow`, or `schedule` |
| `created_at`, `started_at`, `completed_at` | Timestamps |

Poll status via the additive HTTP endpoint:

```
GET /api/jobs/:jobId
```

Returns `401` without auth, `403` if the caller is not the job owner (or admin), `404` if missing. Response shape:

```json
{
  "data": {
    "jobId": "uuid",
    "status": "completed",
    "capability": { "domain": "reports", "name": "generateReport" },
    "source": "http",
    "createdAt": "2026-06-11T12:00:00.000Z",
    "startedAt": "2026-06-11T12:00:01.000Z",
    "completedAt": "2026-06-11T12:00:30.000Z",
    "output": { "url": "..." },
    "error": null
  }
}
```

The table is included automatically in `plumbus migrate generate` output — do not create it manually.

## Optional Peer Dependencies

`@plumbus/core` declares these optional peers — install only when your deployment needs them:

| Package | Install when | Symptom if missing |
|---------|--------------|-------------------|
| `redis` | Production queues, split deployments | Falls back to in-memory with a startup warning |
| `cron-parser` | Flows with `schedule` (cron triggers) | Scheduler cannot compute `nextRunAt` |
| `@plumbus/mcp` | MCP server, MCP job completion sync | MCP features unavailable; worker still runs jobs |

```bash
pnpm add redis cron-parser        # production worker deployment
pnpm add @plumbus/mcp             # MCP integration
```

## Operational CLI

| Command | Purpose |
|---------|---------|
| `plumbus worker start` | Start worker-only process |
| `plumbus worker status` | Static summary of role, queue backend, worker components, resource counts; optional DB probes (outbox pending, DLQ) and Redis depths when configured |
| `plumbus events status` | Outbox backlog, DLQ count, queue backend, Redis queue depths (when configured) |
| `plumbus events dead-letter list` | List failed event deliveries |
| `plumbus events dead-letter retry <id>` | Re-publish a dead-letter row |
| `plumbus events replay <eventId>` | Re-dispatch an outbox event (`--consumer` clears idempotency for that consumer first) |
| `plumbus flow dead-letter list` | List failed flow executions |
| `plumbus flow dead-letter retry <executionId>` | Re-enqueue a flow step |

See [CLI → Commands](../cli/commands.md) for full option reference.

## Observability

Worker processes expose Prometheus-style metrics at `GET /metrics` (health port, default `3001`). Colocated `plumbus dev` / `plumbus start` (`role=all`) also expose `GET /metrics` on the API port when the worker pool runs. Gauges and histograms cover outbox pending depth, per-queue depth (Redis), event delivery duration, consumer failures, capability execution duration, and flow step duration. Event dispatch and consumer attempts are recorded in the audit log (`event.dispatch.*`, `event.consumer.*` with terminal `delivered` / `dead_lettered`). Wire metrics into your monitoring stack alongside `/health` and `/ready` (worker `/ready` pings Redis when durable).

## MCP Job Queue Unification

When `jobQueue` is passed to `McpServerConfig` (or `createMcpServer`), MCP task dispatch for `kind: 'job'` capabilities uses the same `dispatchQueuedJob` path as HTTP — creating a `job_executions` row and publishing to the shared jobs queue. `plumbus mcp serve` resolves queues and passes `jobQueue` **only when a durable shared queue is configured** (Redis via `QUEUE_URL` / `REDIS_URL` or non-localhost `queue.host`). Without Redis, MCP jobs execute in-process (backward compatible for local dev). MCP task status sync in workers uses the job row's `tenant_id` for tenant-scoped updates. Split deployments with Redis require a separate worker process to dequeue and execute.

```typescript
import { createMcpServer } from '@plumbus/mcp';
import { resolveRuntimeQueues } from '@plumbus/core';

const queues = await resolveRuntimeQueues(config);
const server = createMcpServer({
  registry,
  db,
  authAdapter,
  createDependencies,
  jobQueue: queues.jobs, // required for async MCP jobs in split deployments
});
```

When `jobQueue` is omitted, MCP falls back to in-process execution (backward compatible for dev and colocated setups). See [MCP Tasks and Jobs](../mcp/tasks-and-jobs.md).

## See Also

- [Execution Lifecycle](./execution-lifecycle.md) — request and async paths
- [Events](../core-concepts/events.md) — outbox pattern and consumption
- [Flows](../core-concepts/flows.md) — triggers, schedules, dead letters
- [Configuration → Queue](../sdk-reference/configuration.md#queue-configuration) — env vars
- [Upgrading Workers](../upgrading-workers.md) — 0.5.0 migration notes
- [Deployment instructions](../../packages/plumbus-core/instructions/deployment.md) — Docker and Kubernetes worker containers
