# Sampled execution telemetry (core 0.9.0-beta.8)

`onTelemetrySpan` is an optional vendor-neutral `app/server.ts` / `ServerConfig` hook, discovered
by dev/start/worker. Core adds no collector, vendor SDK, network export, credentials or sampler.
See [configuration](configuration.md) and [execution context](execution-context.md).

## Privacy contract

The frozen report contains only validated `traceparent`, `parentSpanId`, `kind` (request,
capability or worker_step), canonical code `name`, UTC `startedAt`, nonnegative `durationMs`,
structured `outcome` and optional allowlisted framework `code`. Unknown codes are omitted.
It never copies request/context objects, observed URLs, headers, queries, payloads, cookies,
authentication, user/tenant identity, raw errors/causes, SQL, locals or AI content. Names come
from registered code definitions. Existing explicit diagnostic hooks keep their own contracts.
The new callback is stripped from handler-visible runtime metadata; no new HTTP endpoint exists.

## Sampling and propagation

The host supplies W3C version-00 context in execution dependencies or in the HTTP header before
routing (a host-owned request hook can choose new heads). Core preserves flags and trace IDs,
derives real child span IDs at execution boundaries, and never makes a head sampling decision.
Missing/invalid legacy carriers remain unsampled. Correlation IDs are separate, not sampling proof.
Ordinary request spans reflect HTTP status; an SSE transport can succeed despite an in-band fault.

Nested capabilities, flow starts, events, jobs and deferred transactional starts carry optional
metadata outside business/auth JSON. Event/job consumers restore it from verified database rows,
not broker-provided identity or carrier metadata. Explicit trusted replay without an old row stays
unsampled. Existing authorization, transactions, flow heartbeat, recovery and accounting remain.
Provider-call and AI-cost hook contexts expose the validated execution carrier; a provider-attempt
span still identifies its actual attempt header rather than pretending the parent is the attempt.

## Non-blocking delivery

Only sampled spans with a configured hook report. Synchronous throws and asynchronous rejection
are contained; core never waits for the callback promise. The host owns bounded buffering and
shutdown flushing. Errors and aggregate metrics stay independent of sampling. Database spans,
browser ingestion and collector integration are outside this source change.

## Migrate before deployment

Add nullable text `traceparent` columns to four existing framework application tables:
`flow_executions`, `flow_start_intents`, `event_outbox`, `job_executions`. Old rows remain null;
no business/auth JSON or existing rows are rewritten. These schemas are already registered in
`collectSchemas`: use the existing `plumbus migrate generate` and `plumbus migrate apply` stream
on the spine and affected tenant planes, reviewing additive ADD COLUMN changes before activating
the new runtime. The framework rewriter makes column additions safe to reapply. Fresh DDL helpers
include the same columns. The new runtime requires these columns even when telemetry is off.

Opaque dispatch hints and Protocol A state gain no fields: workers resolve the plane and read
the authoritative execution row. No application/production migration is applied by this patch.

## Verification

Tests plant private input/identity/exception strings and enforce the exact output-key set. They
cover concurrent/nested calls, null/invalid/unsampled metadata, throwing/pending callbacks, worker
engine recreation and real PostgreSQL persistence. All four repository gates are required before
publication. Framework tests do not establish an application upgrade or collector read-back.

[Local validation evidence](telemetry-validation.json): all four framework gates passed, including
4,011 core tests in 272 files. This run used Node 22; publication still needs its Node 24 gate.
