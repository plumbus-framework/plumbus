# Core 0.8 stabilization upgrade

This family also upgrades the bundled test runner to **Vitest 5.0.4**. Update local/CI/container Node to Node 22.12+ on the 22.x line, Node 24.x, or Node 26+. Review existing test configs and mocks using [testing.md](./testing.md).

Install the coordinated family: core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x. The core 0.9 beta family (npm dist-tag `plumbus-next`: core 0.9.0-beta, UI 0.10, MCP 0.8, voice 0.7, other add-ons 0.4) contains every change in this guide; apps moving to it follow the same checklist with the prerelease-inclusive peer literals (core `>=0.9.0-beta.0 <0.10.0`). Follow `peer-dependencies.md`. Generate/apply database migrations before starting the new runtime; drain old flow-mutating APIs, workers, and schedulers. Old binaries cannot honor new ownership/tick guards. Keep additive schema and history during rollback; stop new processes before rolling back.

## Required application checks

- Review `config/app.config.ts`: CLI startup now loads it. Named `config` and default exports work. Precedence: defaults < file < environment < programmatic overrides, with CLI-enforced environment taking priority. Unknown keys fail validation. `QUEUE_PREFIX` namespaces queues; API and workers must agree.
- `plumbus dev` deliberately uses memory. Once Redis is selected, startup failure never falls back to memory. Install `redis@^4.7.0` where needed. Core provides `cron-parser`; do not install it separately.
- Workers sharing a queue compete for messages and need compatible consumer registrations. Specialized worker groups are not routed pub/sub; separate prefixes do not broadcast events. Deploy consumers before new producers.
- Unmatched events now enter the event DLQ. Configure `workers.eventDelivery.ignoredEventTypes` for intentional no-consumer events, or explicitly choose `unrouted: 'acknowledge'` for observable compatibility behavior.
- Prefer retry `maxAttempts` (total calls). Legacy event `maxRetries` counts total calls; legacy flow `attempts` counts retries after the first. Do not supply both aliases. Flow retries wait durably and receive a fresh budget after successful step advancement.
- Cancellation/leases fence database commits; external effects still require idempotency. Use `ctx.signal` for cooperative cancellation.
- `ctx.jobs.enqueue()` in standard flow capabilities uses caller auth. Built-in transactions persist job intent before commit; publication follows commit and is recoverable. An accepted ID is not job completion. Jobs cannot be synchronous flow steps.
- `onCapabilityError` is per failed capability attempt; `onEventDeadLetter` runs after DLQ persistence and receives identifiers/reason, without payload. Notifications are best-effort and duplicates are possible. Queue failures have separate logs/audits/metrics.
- Flow DLQ retry creates a new execution at the failed step, preserving original verified identity. The failed source stays terminal. Never fabricate system snapshots or erase history to make a replay work.

## Schedules

Use a scheduled flow with empty/defaulted input (`{}` is supplied) and scheduler-authorized step capabilities. New schedules run on the next poll by default, even before the first cron boundary. Optional `firstRun: 'next'`, `overlap: 'skip'`, and explicit IANA `timezone` change those defaults. Without a timezone, process-local time applies. Overdue ticks coalesce; there is no automatic catch-up of every missed boundary (in the core 0.9 beta family, `schedule.catchUpPolicy: 'catch-up'` opts into bounded catch-up; the default is `skip`).

Startup seeds the initial schedule set only when no rows exist; subsequent additions also require deployment reconciliation. Preview `plumbus flow schedule sync` from the complete intended deployment registry, review persisted overrides/removals, then apply with `--apply --expected-revision <revision>`. One deployment owns reconciliation. Changes fence incompatible workers; removals retain tombstones; operator-disabled schedules remain disabled. Explicit reconciliation records superseded overdue ticks as skipped. Use `plumbus flow schedule list --json` for inspection. `PLUMBUS_ENABLE_SCHEDULER=false` disables the scheduler during cutover.

An active flow with an expired lease is recoverable work, not a completed execution. Overlap skipping includes created/running/waiting executions. One tick creates one execution record; effects remain at-least-once.

## Refresh agent guidance

Run `plumbus init --patch --agent all` for wiring v21. `AGENTS.md` is canonical; `CLAUDE.md` imports it. Inline mode embeds core instruction files in `AGENTS.md`. Patching replaces old generated clones while preserving surrounding app notes. Run `plumbus doctor` to check the import and its target. Read `events.md`, `flows.md`, `capabilities.md`, `deployment.md`, and `cli.md` for supported APIs. Preserve framework-first architecture: application work stays in Plumbus primitives and `ctx.*`; do not add custom cron runners, queue recovery loops, or raw schedule-table mutations.
