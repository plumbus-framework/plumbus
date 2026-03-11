// ── Observability: Metrics, Structured Logging, Health ──
// Provides metric counters, histograms, structured logger factory,
// and tracing context propagation for the Plumbus runtime.

import type { LoggerService } from '../types/context.js';

// ── Metrics ──

export interface MetricLabels {
  [key: string]: string;
}

export interface Counter {
  inc(labels?: MetricLabels, value?: number): void;
  get(labels?: MetricLabels): number;
}

export interface Histogram {
  observe(value: number, labels?: MetricLabels): void;
  getCount(labels?: MetricLabels): number;
  getSum(labels?: MetricLabels): number;
}

export interface MetricsRegistry {
  counter(name: string, help: string): Counter;
  histogram(name: string, help: string): Histogram;
  /** Prometheus-compatible text exposition */
  serialize(): string;
}

/** Key for label lookup in maps */
function labelKey(labels?: MetricLabels): string {
  if (!labels) return '';
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
}

/** Create an in-memory metrics registry (Prometheus-style) */
export function createMetricsRegistry(): MetricsRegistry {
  const counters = new Map<string, { help: string; values: Map<string, number> }>();
  const histograms = new Map<
    string,
    { help: string; values: Map<string, { count: number; sum: number }> }
  >();

  return {
    counter(name: string, help: string): Counter {
      if (!counters.has(name)) {
        counters.set(name, { help, values: new Map() });
      }
      const entry = counters.get(name)!;
      return {
        inc(labels?: MetricLabels, value = 1) {
          const key = labelKey(labels);
          entry.values.set(key, (entry.values.get(key) ?? 0) + value);
        },
        get(labels?: MetricLabels) {
          return entry.values.get(labelKey(labels)) ?? 0;
        },
      };
    },

    histogram(name: string, help: string): Histogram {
      if (!histograms.has(name)) {
        histograms.set(name, { help, values: new Map() });
      }
      const entry = histograms.get(name)!;
      return {
        observe(value: number, labels?: MetricLabels) {
          const key = labelKey(labels);
          const existing = entry.values.get(key) ?? { count: 0, sum: 0 };
          existing.count++;
          existing.sum += value;
          entry.values.set(key, existing);
        },
        getCount(labels?: MetricLabels) {
          return entry.values.get(labelKey(labels))?.count ?? 0;
        },
        getSum(labels?: MetricLabels) {
          return entry.values.get(labelKey(labels))?.sum ?? 0;
        },
      };
    },

    serialize(): string {
      const lines: string[] = [];

      for (const [name, entry] of counters) {
        lines.push(`# HELP ${name} ${entry.help}`);
        lines.push(`# TYPE ${name} counter`);
        for (const [key, value] of entry.values) {
          const labels = key ? `{${key}}` : '';
          lines.push(`${name}${labels} ${value}`);
        }
      }

      for (const [name, entry] of histograms) {
        lines.push(`# HELP ${name} ${entry.help}`);
        lines.push(`# TYPE ${name} histogram`);
        for (const [key, value] of entry.values) {
          const labels = key ? `{${key}}` : '';
          lines.push(`${name}_count${labels} ${value.count}`);
          lines.push(`${name}_sum${labels} ${value.sum}`);
        }
      }

      return lines.join('\n');
    },
  };
}

// ── Built-in Plumbus Metrics ──

export interface PlumbusMetrics {
  requestDuration: Histogram;
  requestTotal: Counter;
  requestErrors: Counter;
  capabilityDuration: Histogram;
  capabilityTotal: Counter;
  eventEmitted: Counter;
  eventDelivered: Counter;
  eventFailed: Counter;
  flowStarted: Counter;
  flowCompleted: Counter;
  flowFailed: Counter;
  aiRequestDuration: Histogram;
  aiRequestTotal: Counter;
  queueDepth: Counter;
  registry: MetricsRegistry;
}

/** Create the standard set of Plumbus runtime metrics */
export function createPlumbusMetrics(registry?: MetricsRegistry): PlumbusMetrics {
  const reg = registry ?? createMetricsRegistry();
  return {
    requestDuration: reg.histogram(
      'plumbus_request_duration_ms',
      'HTTP request duration in milliseconds',
    ),
    requestTotal: reg.counter('plumbus_request_total', 'Total HTTP requests'),
    requestErrors: reg.counter('plumbus_request_errors_total', 'Total HTTP request errors'),
    capabilityDuration: reg.histogram(
      'plumbus_capability_duration_ms',
      'Capability execution duration in milliseconds',
    ),
    capabilityTotal: reg.counter('plumbus_capability_total', 'Total capability executions'),
    eventEmitted: reg.counter('plumbus_event_emitted_total', 'Total events emitted'),
    eventDelivered: reg.counter('plumbus_event_delivered_total', 'Total events delivered'),
    eventFailed: reg.counter('plumbus_event_failed_total', 'Total event delivery failures'),
    flowStarted: reg.counter('plumbus_flow_started_total', 'Total flows started'),
    flowCompleted: reg.counter('plumbus_flow_completed_total', 'Total flows completed'),
    flowFailed: reg.counter('plumbus_flow_failed_total', 'Total flows failed'),
    aiRequestDuration: reg.histogram(
      'plumbus_ai_request_duration_ms',
      'AI request duration in milliseconds',
    ),
    aiRequestTotal: reg.counter('plumbus_ai_request_total', 'Total AI requests'),
    queueDepth: reg.counter('plumbus_queue_depth', 'Current queue depth'),
    registry: reg,
  };
}

// ── Structured Logger Factory ──

export interface StructuredLogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: string;
  correlationId?: string;
  tenantId?: string;
  actorId?: string;
  component?: string;
  metadata?: Record<string, unknown>;
}

export interface StructuredLoggerConfig {
  /** Base component name */
  component?: string;
  /** Correlation ID for request tracing */
  correlationId?: string;
  /** Tenant ID for tenant-scoped logging */
  tenantId?: string;
  /** Actor ID for audit trail */
  actorId?: string;
  /** Minimum log level to emit (default: "info") */
  minLevel?: 'debug' | 'info' | 'warn' | 'error';
}

const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

/** Create a structured JSON logger conforming to LoggerService */
export function createStructuredLogger(config?: StructuredLoggerConfig): LoggerService {
  const baseFields = {
    component: config?.component,
    correlationId: config?.correlationId,
    tenantId: config?.tenantId,
    actorId: config?.actorId,
  };
  const minLevel = LOG_LEVEL_ORDER[config?.minLevel ?? 'info'];

  function emit(
    level: StructuredLogEntry['level'],
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (LOG_LEVEL_ORDER[level] < minLevel) return;

    const entry: StructuredLogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...baseFields,
      metadata,
    };

    const line = JSON.stringify(entry);
    switch (level) {
      case 'error':
        console.error(line);
        break;
      case 'warn':
        console.warn(line);
        break;
      default:
        console.info(line);
        break;
    }
  }

  return {
    debug: (message, metadata) => emit('debug', message, metadata),
    info: (message, metadata) => emit('info', message, metadata),
    warn: (message, metadata) => emit('warn', message, metadata),
    error: (message, metadata) => emit('error', message, metadata),
  };
}

// ── Tracing Context ──

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

let traceCounter = 0;

/** Generate a simple trace ID */
export function generateTraceId(): string {
  traceCounter++;
  return `trace-${Date.now()}-${traceCounter}`;
}

/** Generate a simple span ID */
export function generateSpanId(): string {
  traceCounter++;
  return `span-${Date.now()}-${traceCounter}`;
}

/** Create a new root trace context */
export function createTraceContext(): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
  };
}

/** Create a child span from a parent trace context */
export function createChildSpan(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
  };
}

// ── OpenTelemetry-Compatible Distributed Tracing ──

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatusCode = 'unset' | 'ok' | 'error';

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Record<string, string | number | boolean>;
  parentSpanId?: string;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTime: number;
  endTime?: number;
  status: SpanStatusCode;
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;

  /** Set an attribute on the span */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Record an error on the span */
  recordError(error: Error): void;
  /** End the span with the current timestamp */
  end(): void;
}

export interface SpanExporter {
  export(spans: Span[]): void;
}

export interface Tracer {
  /** Start a new span, optionally as a child of the current context */
  startSpan(name: string, options?: SpanOptions): Span;
  /** Get all finished (exported) spans */
  getFinishedSpans(): Span[];
  /** Flush all finished spans to the exporter */
  flush(): void;
}

/** Create an in-memory tracer compatible with OpenTelemetry span semantics */
export function createTracer(traceId?: string, exporter?: SpanExporter): Tracer {
  const rootTraceId = traceId ?? generateTraceId();
  const finishedSpans: Span[] = [];

  return {
    startSpan(name: string, options?: SpanOptions): Span {
      const span: Span = {
        traceId: rootTraceId,
        spanId: generateSpanId(),
        parentSpanId: options?.parentSpanId,
        name,
        kind: options?.kind ?? 'internal',
        startTime: Date.now(),
        status: 'unset',
        attributes: { ...options?.attributes },

        setAttribute(key: string, value: string | number | boolean) {
          span.attributes[key] = value;
        },

        recordError(error: Error) {
          span.status = 'error';
          span.statusMessage = error.message;
          span.attributes['error.type'] = error.name;
          span.attributes['error.message'] = error.message;
          if (error.stack) {
            span.attributes['error.stack'] = error.stack;
          }
        },

        end() {
          span.endTime = Date.now();
          if (span.status === 'unset') span.status = 'ok';
          finishedSpans.push(span);
        },
      };

      return span;
    },

    getFinishedSpans() {
      return [...finishedSpans];
    },

    flush() {
      if (exporter && finishedSpans.length > 0) {
        exporter.export([...finishedSpans]);
        finishedSpans.length = 0;
      }
    },
  };
}

// ── W3C Trace Context Propagation ──

export interface W3CTraceContext {
  version: string;
  traceId: string;
  parentId: string;
  traceFlags: number;
}

/** Parse a W3C traceparent header into structured trace context */
export function parseTraceparent(header: string): W3CTraceContext | null {
  // Format: version-traceId-parentId-traceFlags
  // e.g., "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  const parts = header.trim().split('-');
  if (parts.length !== 4) return null;

  const [version, traceId, parentId, flags] = parts;
  if (!version || !traceId || !parentId || !flags) return null;
  if (version.length !== 2 || traceId.length !== 32 || parentId.length !== 16 || flags.length !== 2)
    return null;
  if (!/^[0-9a-f]+$/i.test(traceId) || !/^[0-9a-f]+$/i.test(parentId)) return null;

  return {
    version,
    traceId,
    parentId,
    traceFlags: parseInt(flags, 16),
  };
}

/** Format a trace context as a W3C traceparent header value */
export function formatTraceparent(ctx: W3CTraceContext): string {
  return `${ctx.version}-${ctx.traceId}-${ctx.parentId}-${ctx.traceFlags.toString(16).padStart(2, '0')}`;
}

/** Extract trace context from HTTP headers (case-insensitive lookup) */
export function extractTraceFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): W3CTraceContext | null {
  const headerValue = headers['traceparent'] ?? headers['Traceparent'] ?? headers['TRACEPARENT'];
  if (!headerValue) return null;
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return null;
  return parseTraceparent(value);
}

/** Inject trace context into HTTP headers for propagation */
export function injectTraceHeaders(
  ctx: W3CTraceContext,
  headers: Record<string, string>,
): Record<string, string> {
  return {
    ...headers,
    traceparent: formatTraceparent(ctx),
  };
}
