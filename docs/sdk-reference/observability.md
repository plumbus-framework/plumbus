# Observability Reference

`@plumbus/core` ships structured logging, Prometheus-style metrics, and W3C trace-context helpers from `packages/plumbus-core/src/observability/`. All symbols below are TIER 1 exports.

## Structured logging

`createStructuredLogger()` returns a `LoggerService` compatible with `ctx.logger`:

```typescript
import { createStructuredLogger } from "@plumbus/core";

const logger = createStructuredLogger({
  component: "billing",
  correlationId: "req-123",
  tenantId: "tenant-1",
  minLevel: "info",
});

logger.info("Invoice created", { invoiceId: "inv-42" });
```

`StructuredLoggerConfig` fields: `component`, `correlationId`, `tenantId`, `actorId`, `minLevel` (`debug` | `info` | `warn` | `error`), `maskKeys` (metadata keys redacted to `***MASKED***`, including nested object keys).

Server and MCP bootstraps derive `maskKeys` from the entity registry (`maskedInLogs` and sensitive classifications). Wrap custom loggers with `withLogMasking(logger, maskKeys)` to apply the same policy.

## Metrics

### Registry

`createMetricsRegistry()` builds an in-memory Prometheus-compatible registry with `counter`, `histogram`, and `gauge` helpers plus `serialize()` for text exposition.

### Built-in runtime metrics

`createPlumbusMetrics(registry?)` registers the standard Plumbus counters, histograms, and gauges:

| Metric | Type | Purpose |
|--------|------|---------|
| `plumbus_request_duration_ms` | histogram | HTTP request duration |
| `plumbus_request_total` | counter | HTTP requests |
| `plumbus_request_errors_total` | counter | HTTP errors |
| `plumbus_capability_duration_ms` | histogram | Capability execution duration |
| `plumbus_capability_total` | counter | Capability invocations |
| `plumbus_event_emitted_total` | counter | Events emitted |
| `plumbus_event_delivered_total` | counter | Events delivered to consumers |
| `plumbus_event_failed_total` | counter | Event delivery failures |
| `plumbus_event_delivery_duration_ms` | histogram | End-to-end event delivery |
| `plumbus_flow_started_total` | counter | Flows started |
| `plumbus_flow_completed_total` | counter | Flows completed |
| `plumbus_flow_failed_total` | counter | Flows failed |
| `plumbus_flow_step_duration_ms` | histogram | Flow step duration |
| `plumbus_ai_request_duration_ms` | histogram | AI request duration |
| `plumbus_ai_request_total` | counter | AI requests |
| `plumbus_outbox_pending` | gauge | Pending outbox rows |
| `plumbus_queue_depth` | gauge | Queue depth per logical queue |

Pass `metrics` to `createServer({ metrics })` to expose `GET /metrics` in colocated deployments. Workers can pass the same object to `createWorkerPool({ metrics })`.

```typescript
import { createPlumbusMetrics } from "@plumbus/core";

const metrics = createPlumbusMetrics();
metrics.capabilityTotal.inc({ capability: "users.getUser", status: "ok" });
console.log(metrics.registry.serialize());
```

## Tracing

### In-process trace context

```typescript
import {
  createTraceContext,
  createChildSpan,
  createTracer,
} from "@plumbus/core";

const root = createTraceContext();
const child = createChildSpan(root);

const tracer = createTracer(root.traceId);
const span = tracer.startSpan("capability.execute", { kind: "internal" });
span.setAttribute("capability", "users.getUser");
span.end();
tracer.flush();
```

### W3C Trace Context propagation

```typescript
import {
  extractTraceFromHeaders,
  injectTraceHeaders,
  parseTraceparent,
  formatTraceparent,
} from "@plumbus/core";

const incoming = extractTraceFromHeaders(request.headers);
const outbound = injectTraceHeaders(
  { version: "00", traceId: "...", parentId: "...", traceFlags: 1 },
  { "content-type": "application/json" },
);
```

`parseTraceparent` / `formatTraceparent` convert the `traceparent` header string to and from `W3CTraceContext`.

## Exported API summary

**Functions:** `createStructuredLogger`, `createMetricsRegistry`, `createPlumbusMetrics`, `createTraceContext`, `createChildSpan`, `createTracer`, `generateTraceId`, `generateSpanId`, `parseTraceparent`, `formatTraceparent`, `extractTraceFromHeaders`, `injectTraceHeaders`

**Types:** `StructuredLoggerConfig`, `StructuredLogEntry`, `MetricsRegistry`, `PlumbusMetrics`, `Counter`, `Histogram`, `MetricLabels`, `TraceContext`, `Tracer`, `Span`, `SpanOptions`, `SpanKind`, `SpanStatusCode`, `SpanExporter`, `W3CTraceContext`

`createMetricsRegistry()` also exposes an internal `gauge` helper for built-in metrics such as `plumbus_outbox_pending`, but `Gauge` is not a TIER 1 export — only `Counter` and `Histogram` types are public.

See also [Configuration → ServerConfig](./configuration.md#server-configuration) for wiring `metrics` into the HTTP server.


## Agent-readable failure evidence

Error reports should support a human or coding agent answering **who was affected, what
failed, which code ran, and what evidence is needed to reproduce it**. Generic exception names
or severity alone are insufficient. See [error hooks](configuration.md#oncapabilityerror-hook).

A host reporter should deliberately select the following evidence:

| Evidence | Source / constraints |
| --- | --- |
| Affected tenant and application principal | Verified `tenantId`, `userId`, or terminal-flow `actor`; never a request-supplied identity override |
| Initiator versus executor | Event `diagnostics.initiatingActor` is the persisted original actor; callback `userId` is the executing service account. An actor may itself be a service; do not label an unknown principal as a human |
| Actual failure | Explicit `originalError`, original stack/cause and structured error code. Scrub messages/causes before shared export; do not record credentials or complete request objects |
| Code and contract | Canonical operation/capability chain, capability version, source-mapped frames and the host's exact application commit/release/framework/runtime versions |
| Execution coordinates | Correlation ID, registered HTTP route/method/status or job/event/flow/step identifiers; definition version/digest for pinned flows when available |
| Reproduction evidence | A reference to a sanitized fixture or an authorized tenant-local execution/input snapshot; never silently upload arbitrary private input or database rows |
| Expected versus observed | Known contract/test expectation and observed failure, with unknown fields clearly labeled |

The framework does not automatically capture input values, authentication snapshots, session
secrets, request bodies, database state, local variables or replay credentials. If reproduction
requires these, record a reference and the missing evidence rather than manufacturing a minimal
example and claiming it reproduces the issue. A report may be ready for code triage while still
requiring authorized reproduction data.

Keep diagnostic facts separate from an agent's hypothesis. A proposed root cause is not a
verified reproduction until a bounded, isolated regression test demonstrates the failure against
the exact code/definition versions. Persist the test/evidence reference and outcome separately.
Reporters may retain privacy-safe schema field names or approved fixture inputs under an explicit
application policy; the framework's original-error hook is not blanket authorization to export
private data.

Raw provenance is scoped to live error/result objects through private non-enumerable properties;
there is no process-wide error cache and no added persistent stack storage. HTTP behavior,
retry/lease/cancellation semantics and event/job recovery are unchanged. Host callback failures
remain isolated from execution. This patch supplies evidence, not an automatic replay or agent
write authorization.
