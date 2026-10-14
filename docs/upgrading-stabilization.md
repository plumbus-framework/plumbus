# Stabilization release

This family also upgrades the bundled test runner to **Vitest 5.0.4**. Update local/CI/container Node to Node 22.12+ on the 22.x line, Node 24.x, or Node 26+. Review existing test configs and mocks using [the Vitest migration guide](./upgrading-vitest.md).

Core 0.8.0 fixes the reviewed queue, flow, scheduler, configuration, and agent-guidance issues (PLB-01 through PLB-10). This release requires database migrations and a coordinated cutover. UI is 0.9.0, MCP 0.7.0, voice 0.6.0, and all other Plumbus packages 0.3.0. Install matching versions together; do not widen peer ranges to admit the previous family.

The [core changelog](../packages/plumbus-core/CHANGELOG.md) maps the implementation to each original issue (PLB-01 through PLB-10). Add-on changelogs record their peer/dependency changes; their runtime APIs are unchanged in this release.

## Upgrade and rollback

1. Back up PostgreSQL and inventory active executions, intended unhandled event types, persisted schedule overrides, and application config files. Config files previously ignored by the CLI now take effect.
2. Generate and inspect migrations with the new packages, then apply them before starting new processes. Changes add flow claim tokens/wait metadata/replay provenance, schedule definitions/ticks, and durable pending job publication fields. Existing execution history is retained.
3. Drain old API processes that mutate flows, workers, and schedulers. Old binaries do not participate in fencing or atomic reclamation and must not share active processing with new binaries. `PLUMBUS_ENABLE_SCHEDULER=false` disables the new scheduler while preparing a cutover.
4. Preview `plumbus flow schedule sync`. It reports a revision and changes. Review legacy persisted cron overrides, then apply with `plumbus flow schedule sync --apply --expected-revision <revision>`. Use one deployment owner and the complete intended flow registry. Removed schedules are retained as tombstones; operator-disabled schedules stay disabled. A changed definition explicitly supersedes an overdue unmaterialized tick and records that skip.
5. Start the new processes, inspect `/ready`, queue diagnostics, pending job publication and dead letters, and run `plumbus init --patch --agent all` for wiring v21. Test a capability, event, job, delayed retry, and scheduled flow.

Rollback requires stopping new processes first. Retain additive columns, tick records, and replay history. Reconcile definitions deliberately before resuming a previously compatible deployment; do not run mixed old/new workers or drop durable records to make a rollback start. The old scheduler cannot honor new tick guarantees.

## Configuration

`loadConfig()` merges typed nested programmatic overrides over environment defaults. Unknown keys, invalid queue timings, and conflicting retry aliases are rejected. `loadAppConfig()` additionally loads `config/app.config.ts`, `.js`, or `.mjs` (named `config` or default export). CLI startup uses this loader, including worker and operational commands. Precedence is defaults, file, explicitly present environment values, then programmatic overrides. CLI-forced development/production mode wins over the file.

Queue fields include `prefix`, `url`, `backend`, `pollIntervalMs`, `visibilityTimeoutSec`, `reclaimIntervalMs`, `startupTimeoutMs`, `operationTimeoutMs`, and `shutdownTimeoutMs`. Environment equivalents include `QUEUE_PREFIX`, `QUEUE_URL`/`REDIS_URL`, `QUEUE_BACKEND`, `QUEUE_POLL_INTERVAL_MS`, `QUEUE_VISIBILITY_TIMEOUT_SEC`, `QUEUE_RECLAIM_INTERVAL_MS`, `QUEUE_STARTUP_TIMEOUT_MS`, and `QUEUE_OPERATION_TIMEOUT_MS`. Keep API and worker namespaces/environments aligned.

Development deliberately uses memory queues. Explicit memory mode and unconfigured colocated memory mode remain supported. Once Redis is selected, missing driver, bad credentials, connection failure, or startup timeout fails startup; runtime disconnects never select memory. Install `redis@^4.7.0` for Redis deployments. The framework now owns `cron-parser`; consumers do not install it.

## Event delivery

New `workers.eventDelivery` config controls `retry`, `unrouted`, and `ignoredEventTypes`. `retry` accepts `maxAttempts` (total calls), `backoff`, `baseDelayMs`, and `maxDelayMs`. A capability can override it with `trigger.retry`; manual consumers can set `retry`. The default remains three calls. Legacy event `maxRetries` and `defaultMaxRetries` mean total calls, despite their names. Legacy flow `retry.attempts` means retries after the initial call. Prefer `maxAttempts`; conflicting aliases are errors.

An event without a local matching consumer is recorded as `unrouted` and dead-lettered by default. Use an explicit ignored event-type list for intentional no-consumer events, or `unrouted: 'acknowledge'` for observable legacy behavior. Neither option routes work to a different worker pool. Workers sharing a queue compete for messages and must have compatible consumer registries; separate prefixes do not provide fan-out. Deploy consumers across the fleet before producers emit new event types.

`onCapabilityError` remains per failed capability attempt. `onEventDeadLetter`, exported from `app/server.ts`, receives the persisted dead-letter ID, event/consumer identifiers, attempt count, tenant, and reason. Payloads are omitted. It runs after persistence, is best-effort, and may be missed or repeated across crashes. Callback failures are logged without undoing persistence. Failed persistence prevents acknowledgement. Replays can reuse the original event ID, so a terminal record is not a permanent ban on redelivery.

Validation/access/dependency errors or errors explicitly marked `metadata.retryable: false` are permanent; unknown application errors remain retryable. Queue polling/subscriber failures are logged with bounded retry cadence. Invalid envelopes are retained in `{prefix}:invalid`. Redis claim/reclaim/renewal operations require scripting support. Active deliveries renew visibility; shutdown stops renewals and leaves unacknowledged work recoverable. At-least-once execution still requires idempotent effects.

## Flows and jobs

Every claim has a unique token. State transitions require current ownership, active status, and a valid lease. Cancellation clears ownership; stale runners stop without finalizing another worker's execution. Cancellation is cooperative through `ctx.signal` and cannot undo external effects already performed.

Retries persist a deadline, release the worker, and resume the failed step after the deadline. The budget resets on advancement to another step activation. Existing executions retain their consumed counter for the current step during upgrade; their next successful advancement resets it. New flow policies use `maxAttempts`; legacy `attempts: N` continues to permit the initial call plus N retries. Fixed/exponential backoff has a bounded maximum.

Terminal failure preserves the final attempt/history and creates a flow dead-letter snapshot. A bounded sweep recovers failed snapshots whose initial write failed. `plumbus flow dead-letter list` lists snapshots, not all failed executions. `plumbus flow dead-letter retry <executionId>` creates a new execution at the failed step, validates original caller identity and current definition compatibility, and returns its ID. The source stays terminal; concurrent/repeated requests reuse the recorded replay ID. Retrying the replay itself uses its own eventual dead letter. Side effects remain the application's idempotency responsibility.

Flow capabilities can call `ctx.jobs.enqueue()` using the flow caller's identity. Job targets remain prohibited as synchronous flow steps. Built-in transaction wiring persists job intent inside the transaction and publishes after commit; rollback publishes nothing. Committed publication failures remain pending for worker reconciliation. An accepted ID identifies durable intent, not completed execution. Explicit UUID job IDs may be reused only for the same authorized caller/tenant, target, and input. Random IDs do not deduplicate repeated business requests.

## Schedules

New schedules default to `firstRun: 'immediate'` (due on the next scheduler poll), `overlap: 'allow'`, and the scheduler process's timezone. Set an explicit IANA `timezone` for consistent deployments; `firstRun: 'next'` waits for the first cron boundary. Cron determines subsequent runs, not an automatic catch-up for every missed boundary: overdue work coalesces to one tick, then the next future occurrence.

Scheduled flows receive `{}` under scheduler auth. Use empty/defaulted input schemas and allow the scheduler identity on step capabilities. Invalid expressions fail with the flow name/expression; they no longer become hourly work. The supported parser defines weekday, step, day-of-month/day-of-week and DST behavior consistently.

One database transaction locks a due schedule, creates its unique tick and execution (or explicit overlap skip), and advances timing. Redis is a wake-up hint; database reconciliation recovers committed executions if wake publication fails. This guarantees one execution record per tick, not exactly-once external actions.

`overlap: 'skip'` considers created, running, and waiting executions active. An expired lease remains an active recoverable execution. Cancellation/recovery must be explicit for indefinitely waiting work. Pre-adoption active executions without schedule provenance conservatively block overlap skipping for the same flow name. New workers skip definitions whose persisted fingerprint differs from their registry. Startup seeds the initial schedule set and never adds to or overwrites an established deployment manifest. Use the deployment reconciliation command for changes/removal; inspect `plumbus flow schedule list --json`.

## Agent guidance and validation

Wiring v21 uses canonical `AGENTS.md` and a managed `@AGENTS.md` import in `CLAUDE.md`, retaining the deployment/stabilization references introduced in v20. Run `plumbus init --patch --agent all` to migrate old cloned managed blocks without losing surrounding app notes. `plumbus doctor` validates the import and target. `--inline` embeds shipped core instruction content in `AGENTS.md`; optional add-on recipes retain package references. Framework primitives and `ctx.*` remain mandatory for business logic; do not implement custom Redis recovery, cron loops, or direct schedule-table edits in applications.

Framework validation includes real PostgreSQL/Redis race and failure-path tests, configuration precedence, durable job rollback/recovery, replay, and agent-generator coverage. Run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test` before release, plus packed npm consumer compatibility checks. Integration fixtures need `redis-server` and PostgreSQL binaries; set `PLUMBUS_TEST_POSTGRES_BIN` when PostgreSQL is not in `/usr/lib/postgresql/16/bin`.

Wait signals are fenced to their original waiting activation; a stale signal cannot advance a later activation of the same wait. Retry and schedule deadlines use database time, and Redis visibility uses Redis time.

A delivery whose job is already claimed is deferred without exhausting event retry attempts or dead-lettering the active job. It remains recoverable for a later delivery.

Queue shutdown clears visibility-renewal timers before its bounded drain, so a hung handler cannot keep a closed queue alive through a renewal timer.
