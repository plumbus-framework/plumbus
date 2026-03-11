import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChildSpan,
  createMetricsRegistry,
  createPlumbusMetrics,
  createStructuredLogger,
  createTraceContext,
  generateSpanId,
  generateTraceId,
} from '../metrics.js';

// ── Tests ──

describe('Observability', () => {
  describe('MetricsRegistry', () => {
    it('creates a registry with counter, histogram, and serialize', () => {
      const registry = createMetricsRegistry();
      expect(registry).toHaveProperty('counter');
      expect(registry).toHaveProperty('histogram');
      expect(registry).toHaveProperty('serialize');
    });

    describe('counter', () => {
      it('starts at 0', () => {
        const registry = createMetricsRegistry();
        const counter = registry.counter('test_counter', 'A test counter');
        expect(counter.get()).toBe(0);
      });

      it('increments by 1 by default', () => {
        const registry = createMetricsRegistry();
        const counter = registry.counter('test_counter', 'A test counter');
        counter.inc();
        expect(counter.get()).toBe(1);
      });

      it('increments by a custom value', () => {
        const registry = createMetricsRegistry();
        const counter = registry.counter('test_counter', 'A test counter');
        counter.inc(undefined, 5);
        expect(counter.get()).toBe(5);
      });

      it('supports labeled counters independently', () => {
        const registry = createMetricsRegistry();
        const counter = registry.counter('http_requests', 'Total HTTP requests');
        counter.inc({ method: 'GET' }, 3);
        counter.inc({ method: 'POST' }, 2);
        expect(counter.get({ method: 'GET' })).toBe(3);
        expect(counter.get({ method: 'POST' })).toBe(2);
        expect(counter.get()).toBe(0); // unlabeled is separate
      });

      it('accumulates increments', () => {
        const registry = createMetricsRegistry();
        const counter = registry.counter('test', 't');
        counter.inc();
        counter.inc();
        counter.inc();
        expect(counter.get()).toBe(3);
      });

      it('returns the same counter instance for the same name', () => {
        const registry = createMetricsRegistry();
        const c1 = registry.counter('my_counter', 'help');
        c1.inc();
        const c2 = registry.counter('my_counter', 'help');
        expect(c2.get()).toBe(1);
      });
    });

    describe('histogram', () => {
      it('starts with count 0 and sum 0', () => {
        const registry = createMetricsRegistry();
        const h = registry.histogram('test_histogram', 'A test histogram');
        expect(h.getCount()).toBe(0);
        expect(h.getSum()).toBe(0);
      });

      it('tracks count and sum of observations', () => {
        const registry = createMetricsRegistry();
        const h = registry.histogram('duration', 'Duration');
        h.observe(10);
        h.observe(20);
        h.observe(30);
        expect(h.getCount()).toBe(3);
        expect(h.getSum()).toBe(60);
      });

      it('supports labeled histograms independently', () => {
        const registry = createMetricsRegistry();
        const h = registry.histogram('request_duration', 'Request duration');
        h.observe(100, { route: '/api' });
        h.observe(200, { route: '/api' });
        h.observe(50, { route: '/health' });
        expect(h.getCount({ route: '/api' })).toBe(2);
        expect(h.getSum({ route: '/api' })).toBe(300);
        expect(h.getCount({ route: '/health' })).toBe(1);
        expect(h.getSum({ route: '/health' })).toBe(50);
      });

      it('returns the same histogram instance for the same name', () => {
        const registry = createMetricsRegistry();
        const h1 = registry.histogram('my_hist', 'help');
        h1.observe(42);
        const h2 = registry.histogram('my_hist', 'help');
        expect(h2.getCount()).toBe(1);
        expect(h2.getSum()).toBe(42);
      });
    });

    describe('serialize', () => {
      it('serializes empty registry to empty string', () => {
        const registry = createMetricsRegistry();
        expect(registry.serialize()).toBe('');
      });

      it('serializes counters in Prometheus format', () => {
        const registry = createMetricsRegistry();
        const c = registry.counter('http_total', 'Total HTTP requests');
        c.inc();
        c.inc();
        const output = registry.serialize();
        expect(output).toContain('# HELP http_total Total HTTP requests');
        expect(output).toContain('# TYPE http_total counter');
        expect(output).toContain('http_total 2');
      });

      it('serializes labeled counters with label syntax', () => {
        const registry = createMetricsRegistry();
        const c = registry.counter('http_total', 'Total');
        c.inc({ method: 'GET' }, 5);
        const output = registry.serialize();
        expect(output).toContain('http_total{method="GET"} 5');
      });

      it('serializes histograms with _count and _sum suffixes', () => {
        const registry = createMetricsRegistry();
        const h = registry.histogram('latency', 'Latency');
        h.observe(10);
        h.observe(20);
        const output = registry.serialize();
        expect(output).toContain('# HELP latency Latency');
        expect(output).toContain('# TYPE latency histogram');
        expect(output).toContain('latency_count 2');
        expect(output).toContain('latency_sum 30');
      });

      it('serializes multiple metrics together', () => {
        const registry = createMetricsRegistry();
        registry.counter('a_counter', 'A').inc();
        registry.histogram('b_hist', 'B').observe(99);
        const output = registry.serialize();
        expect(output).toContain('a_counter');
        expect(output).toContain('b_hist');
      });

      it('sorts labels deterministically', () => {
        const registry = createMetricsRegistry();
        const c = registry.counter('test', 'test');
        c.inc({ z: '1', a: '2' });
        const output = registry.serialize();
        // Labels should be sorted: a="2",z="1"
        expect(output).toContain('test{a="2",z="1"} 1');
      });
    });
  });

  describe('PlumbusMetrics', () => {
    it('creates all 14 standard metrics', () => {
      const metrics = createPlumbusMetrics();
      expect(metrics.requestDuration).toBeDefined();
      expect(metrics.requestTotal).toBeDefined();
      expect(metrics.requestErrors).toBeDefined();
      expect(metrics.capabilityDuration).toBeDefined();
      expect(metrics.capabilityTotal).toBeDefined();
      expect(metrics.eventEmitted).toBeDefined();
      expect(metrics.eventDelivered).toBeDefined();
      expect(metrics.eventFailed).toBeDefined();
      expect(metrics.flowStarted).toBeDefined();
      expect(metrics.flowCompleted).toBeDefined();
      expect(metrics.flowFailed).toBeDefined();
      expect(metrics.aiRequestDuration).toBeDefined();
      expect(metrics.aiRequestTotal).toBeDefined();
      expect(metrics.queueDepth).toBeDefined();
    });

    it('exposes registry for serialization', () => {
      const metrics = createPlumbusMetrics();
      expect(metrics.registry).toBeDefined();
      expect(typeof metrics.registry.serialize).toBe('function');
    });

    it('uses a shared registry so metrics appear in serialize()', () => {
      const metrics = createPlumbusMetrics();
      metrics.requestTotal.inc();
      metrics.requestDuration.observe(42);
      const output = metrics.registry.serialize();
      expect(output).toContain('plumbus_request_total');
      expect(output).toContain('plumbus_request_duration_ms');
    });

    it('accepts a custom registry', () => {
      const registry = createMetricsRegistry();
      const metrics = createPlumbusMetrics(registry);
      metrics.flowStarted.inc();
      const output = registry.serialize();
      expect(output).toContain('plumbus_flow_started_total');
    });
  });

  describe('StructuredLogger', () => {
    beforeEach(() => {
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('outputs JSON to console.info for info level', () => {
      const logger = createStructuredLogger({ component: 'test' });
      logger.info('hello');
      expect(console.info).toHaveBeenCalledTimes(1);
      const output = JSON.parse((console.info as any).mock.calls[0][0]);
      expect(output.level).toBe('info');
      expect(output.message).toBe('hello');
      expect(output.component).toBe('test');
      expect(output.timestamp).toBeDefined();
    });

    it('outputs JSON to console.warn for warn level', () => {
      const logger = createStructuredLogger();
      logger.warn('watch out');
      expect(console.warn).toHaveBeenCalledTimes(1);
      const output = JSON.parse((console.warn as any).mock.calls[0][0]);
      expect(output.level).toBe('warn');
      expect(output.message).toBe('watch out');
    });

    it('outputs JSON to console.error for error level', () => {
      const logger = createStructuredLogger();
      logger.error('something broke');
      expect(console.error).toHaveBeenCalledTimes(1);
      const output = JSON.parse((console.error as any).mock.calls[0][0]);
      expect(output.level).toBe('error');
      expect(output.message).toBe('something broke');
    });

    it('includes metadata in the log entry', () => {
      const logger = createStructuredLogger();
      logger.info('with meta', { requestId: 'abc' });
      const output = JSON.parse((console.info as any).mock.calls[0][0]);
      expect(output.metadata).toEqual({ requestId: 'abc' });
    });

    it('includes correlationId, tenantId, actorId from config', () => {
      const logger = createStructuredLogger({
        correlationId: 'corr-1',
        tenantId: 't-1',
        actorId: 'u-1',
      });
      logger.info('test');
      const output = JSON.parse((console.info as any).mock.calls[0][0]);
      expect(output.correlationId).toBe('corr-1');
      expect(output.tenantId).toBe('t-1');
      expect(output.actorId).toBe('u-1');
    });

    it('respects minLevel — skips info when minLevel is warn', () => {
      const logger = createStructuredLogger({ minLevel: 'warn' });
      logger.info('should be skipped');
      logger.warn('should appear');
      expect(console.info).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('respects minLevel — skips warn when minLevel is error', () => {
      const logger = createStructuredLogger({ minLevel: 'error' });
      logger.info('skip');
      logger.warn('skip');
      logger.error('show');
      expect(console.info).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('defaults to info minLevel', () => {
      const logger = createStructuredLogger();
      logger.info('should appear');
      expect(console.info).toHaveBeenCalledTimes(1);
    });
  });

  describe('TraceContext', () => {
    it('creates a root trace context with traceId and spanId', () => {
      const ctx = createTraceContext();
      expect(ctx.traceId).toBeDefined();
      expect(ctx.spanId).toBeDefined();
      expect(ctx.parentSpanId).toBeUndefined();
    });

    it('generates unique trace IDs', () => {
      const id1 = generateTraceId();
      const id2 = generateTraceId();
      expect(id1).not.toBe(id2);
    });

    it('generates unique span IDs', () => {
      const id1 = generateSpanId();
      const id2 = generateSpanId();
      expect(id1).not.toBe(id2);
    });

    it("trace ID starts with 'trace-'", () => {
      expect(generateTraceId()).toMatch(/^trace-/);
    });

    it("span ID starts with 'span-'", () => {
      expect(generateSpanId()).toMatch(/^span-/);
    });

    it('createChildSpan preserves parent traceId', () => {
      const parent = createTraceContext();
      const child = createChildSpan(parent);
      expect(child.traceId).toBe(parent.traceId);
    });

    it('createChildSpan sets parentSpanId to parent spanId', () => {
      const parent = createTraceContext();
      const child = createChildSpan(parent);
      expect(child.parentSpanId).toBe(parent.spanId);
    });

    it('createChildSpan generates a new spanId', () => {
      const parent = createTraceContext();
      const child = createChildSpan(parent);
      expect(child.spanId).not.toBe(parent.spanId);
    });

    it('supports multi-level spans', () => {
      const root = createTraceContext();
      const child = createChildSpan(root);
      const grandchild = createChildSpan(child);
      expect(grandchild.traceId).toBe(root.traceId);
      expect(grandchild.parentSpanId).toBe(child.spanId);
      expect(grandchild.spanId).not.toBe(child.spanId);
    });
  });
});
