// ── Observability Module ──
// Structured logging, metrics (counters, histograms), and distributed tracing
// (W3C Trace Context). Provides ctx.logger and trace propagation.
//
// Key exports: createStructuredLogger, createPlumbusMetrics, createTracer

export type { ErrorExecutionDetails } from './error-diagnostics.js';
// Internal provenance helpers; deliberately not re-exported by the public SDK root.
export {
  exposeOriginalError,
  getErrorExecutionDetails,
  getOriginalError,
  preserveOriginalError,
} from './error-diagnostics.js';
export type {
  Counter,
  Histogram,
  MetricLabels,
  MetricsRegistry,
  PlumbusMetrics,
  Span,
  SpanExporter,
  SpanKind,
  SpanOptions,
  SpanStatusCode,
  StructuredLogEntry,
  StructuredLoggerConfig,
  TraceContext,
  Tracer,
  W3CTraceContext,
} from './metrics.js';
export {
  createChildSpan,
  createMetricsRegistry,
  createPlumbusMetrics,
  createStructuredLogger,
  createTraceContext,
  createTracer,
  extractTraceFromHeaders,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  injectTraceHeaders,
  parseTraceparent,
  withLogMasking,
} from './metrics.js';
export type { CompletedTelemetrySpan, TelemetrySpanHook } from './telemetry.js';
export { startTelemetrySpan, validatedTraceparent } from './telemetry.js';
