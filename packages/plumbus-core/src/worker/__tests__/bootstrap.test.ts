import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventQueue } from '../../events/queue.js';
import type { StepExecutorDeps } from '../../flows/step-executor.js';
import type { AuditService } from '../../types/audit.js';
import type { PlumbusConfig } from '../../types/config.js';
import type { LoggerService } from '../../types/context.js';

// ── Mocks ──

const mockDispatcher = { start: vi.fn(), stop: vi.fn(), poll: vi.fn(), isRunning: false };
const mockEventWorker = { start: vi.fn(), stop: vi.fn(), deliver: vi.fn(), isRunning: false };
const mockFlowEngine = {
  start: vi.fn(async () => ({})),
  runNext: vi.fn(async () => ({})),
  resume: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
};
const mockScheduler = {
  syncSchedules: vi.fn(async () => 2),
  poll: vi.fn(async () => 0),
  start: vi.fn(),
  stop: vi.fn(),
  isRunning: false,
};

vi.mock('../../events/dispatcher.js', () => ({
  createOutboxDispatcher: vi.fn(() => mockDispatcher),
}));

vi.mock('../../events/worker.js', () => ({
  createEventWorker: vi.fn(() => mockEventWorker),
}));

vi.mock('../../flows/engine.js', () => ({
  createFlowEngine: vi.fn(() => mockFlowEngine),
}));

vi.mock('../../flows/scheduler.js', () => ({
  createFlowScheduler: vi.fn(() => mockScheduler),
}));

vi.mock('../../events/idempotency.js', () => ({
  createIdempotencyService: vi.fn(() => ({
    check: vi.fn(async () => false),
    record: vi.fn(async () => {}),
  })),
}));

import { ConsumerRegistry } from '../../events/consumer-registry.js';
import { FlowRegistry } from '../../flows/registry.js';
import type { WorkerPoolConfig } from '../bootstrap.js';
import { createWorkerPool } from '../bootstrap.js';

// ── Helpers ──

function makeConfig(): PlumbusConfig {
  return {
    environment: 'development',
    database: {
      host: 'localhost',
      port: 5432,
      database: 'plumbus_dev',
      user: 'postgres',
      password: 'postgres',
    },
    queue: { host: 'localhost', port: 6379, prefix: 'plumbus:dev' },
    auth: { provider: 'jwt', secret: 'test-secret' },
  };
}

function makeQueue(): EventQueue {
  return {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  };
}

function makeStepDeps(): StepExecutorDeps {
  return {
    executeCapability: vi.fn(async () => ({ success: true, data: {} })),
    evaluateCondition: vi.fn(() => true),
  };
}

function makePoolConfig(overrides?: Partial<WorkerPoolConfig>): WorkerPoolConfig {
  return {
    config: makeConfig(),
    db: {} as any,
    queue: makeQueue(),
    consumers: new ConsumerRegistry(),
    flows: new FlowRegistry(),
    stepDeps: makeStepDeps(),
    ...overrides,
  };
}

// ── Tests ──

describe('Worker Bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createWorkerPool', () => {
    it('returns a WorkerPool with start, stop, and isRunning', () => {
      const pool = createWorkerPool(makePoolConfig());
      expect(pool).toHaveProperty('start');
      expect(pool).toHaveProperty('stop');
      expect(pool).toHaveProperty('isRunning');
      expect(typeof pool.start).toBe('function');
      expect(typeof pool.stop).toBe('function');
    });

    it('isRunning is false initially', () => {
      const pool = createWorkerPool(makePoolConfig());
      expect(pool.isRunning).toBe(false);
    });
  });

  describe('start()', () => {
    it('sets isRunning to true', async () => {
      const pool = createWorkerPool(makePoolConfig());
      await pool.start();
      expect(pool.isRunning).toBe(true);
    });

    it('syncs schedules before starting scheduler', async () => {
      const pool = createWorkerPool(makePoolConfig());
      await pool.start();
      expect(mockScheduler.syncSchedules).toHaveBeenCalled();
      expect(mockScheduler.start).toHaveBeenCalled();
    });

    it('starts dispatcher', async () => {
      const pool = createWorkerPool(makePoolConfig());
      await pool.start();
      expect(mockDispatcher.start).toHaveBeenCalled();
    });

    it('starts event worker', async () => {
      const pool = createWorkerPool(makePoolConfig());
      await pool.start();
      expect(mockEventWorker.start).toHaveBeenCalled();
    });

    it('is idempotent — calling start twice does not double-start', async () => {
      const pool = createWorkerPool(makePoolConfig());
      await pool.start();
      await pool.start();
      expect(mockDispatcher.start).toHaveBeenCalledTimes(1);
      expect(mockScheduler.start).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop()', () => {
    it('sets isRunning to false', async () => {
      const pool = createWorkerPool(makePoolConfig());
      await pool.start();
      await pool.stop();
      expect(pool.isRunning).toBe(false);
    });

    it('stops all workers', async () => {
      const pool = createWorkerPool(makePoolConfig());
      await pool.start();
      await pool.stop();
      expect(mockScheduler.stop).toHaveBeenCalled();
      expect(mockDispatcher.stop).toHaveBeenCalled();
      expect(mockEventWorker.stop).toHaveBeenCalled();
    });

    it('closes the queue on stop', async () => {
      const queue = makeQueue();
      const pool = createWorkerPool(makePoolConfig({ queue }));
      await pool.start();
      await pool.stop();
      expect(queue.close).toHaveBeenCalled();
    });

    it('is idempotent — calling stop when not running does nothing', async () => {
      const queue = makeQueue();
      const pool = createWorkerPool(makePoolConfig({ queue }));
      await pool.stop();
      expect(queue.close).not.toHaveBeenCalled();
    });
  });

  describe('enable flags', () => {
    it('does not start dispatcher when enableDispatcher is false', async () => {
      const pool = createWorkerPool(makePoolConfig({ enableDispatcher: false }));
      await pool.start();
      expect(mockDispatcher.start).not.toHaveBeenCalled();
    });

    it('does not start event worker when enableEventWorker is false', async () => {
      const pool = createWorkerPool(makePoolConfig({ enableEventWorker: false }));
      await pool.start();
      expect(mockEventWorker.start).not.toHaveBeenCalled();
    });

    it('does not start scheduler when enableScheduler is false', async () => {
      const pool = createWorkerPool(makePoolConfig({ enableScheduler: false }));
      await pool.start();
      expect(mockScheduler.syncSchedules).not.toHaveBeenCalled();
      expect(mockScheduler.start).not.toHaveBeenCalled();
    });

    it('does not stop disabled workers on stop', async () => {
      const pool = createWorkerPool(
        makePoolConfig({
          enableDispatcher: false,
          enableEventWorker: false,
          enableScheduler: false,
        }),
      );
      await pool.start();
      await pool.stop();
      expect(mockDispatcher.stop).not.toHaveBeenCalled();
      expect(mockEventWorker.stop).not.toHaveBeenCalled();
      expect(mockScheduler.stop).not.toHaveBeenCalled();
    });
  });

  describe('custom logger', () => {
    it('uses provided logger', async () => {
      const logger: LoggerService = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const pool = createWorkerPool(makePoolConfig({ logger }));
      await pool.start();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Worker pool started'));
    });
  });

  describe('custom audit service', () => {
    it('accepts an audit service without error', () => {
      const audit: AuditService = {
        record: vi.fn(async () => {}),
      };
      const pool = createWorkerPool(makePoolConfig({ audit }));
      expect(pool).toBeDefined();
    });
  });
});
