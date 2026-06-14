import type { EventQueue } from '../events/queue.js';
import type { ExecutionContext } from '../types/context.js';
import type { PlumbusMetrics } from '../observability/metrics.js';
import { FlowStatus } from './state-machine.js';
import { parseFlowStepExecutionId } from './flow-queue.js';
import type { createFlowEngine } from './engine.js';
import type { LoggerService } from '../types/context.js';

export interface FlowStepConsumerConfig {
  flowsQueue: EventQueue;
  engine: ReturnType<typeof createFlowEngine>;
  buildContext: () => ExecutionContext;
  logger?: LoggerService;
  metrics?: PlumbusMetrics;
  /** Re-enqueue when execution still running after a drain cycle. */
  onReenqueue?: (executionId: string) => Promise<void>;
  maxStepsPerCycle?: number;
}

/**
 * Subscribe to the flows queue and execute flow steps when wake messages arrive.
 * Complements the DB poll loop — queue provides immediate wake, poll is fallback.
 */
export function createFlowStepConsumer(config: FlowStepConsumerConfig): {
  start(): void;
  stop(): void;
} {
  const { flowsQueue, engine, buildContext, logger, onReenqueue, metrics } = config;
  const maxSteps = config.maxStepsPerCycle ?? 1000;
  let unsubscribe: (() => void) | null = null;

  async function handleEnvelope(envelope: { eventType: string }): Promise<void> {
    const executionId = parseFlowStepExecutionId(envelope.eventType);
    if (!executionId) return;

    const claimed = await engine.claimExecution(executionId);
    if (!claimed) {
      logger?.debug?.('Flow step wake skipped — execution not claimable', { executionId });
      return;
    }

    const baseCtx = buildContext();
    let stepsRun = 0;
    const started = Date.now();
    try {
      while (stepsRun < maxSteps) {
        const result = await engine.runNext(executionId, baseCtx);
        stepsRun += 1;
        if (result.status !== FlowStatus.Running) {
          metrics?.flowCompleted.inc({ source: 'queue' });
          return;
        }
      }
      if (onReenqueue) {
        await onReenqueue(executionId);
      }
    } catch (err) {
      metrics?.flowFailed.inc({ source: 'queue' });
      logger?.error('Flow step consumer failed', {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await engine.markFailedFromRunner(executionId, err);
      } catch (finalizeErr) {
        logger?.error('Failed to finalize flow after step consumer error', {
          executionId,
          error: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
        });
      }
    } finally {
      metrics?.flowStepDuration.observe(Date.now() - started, {
        source: 'queue',
      });
    }
  }

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = flowsQueue.subscribe(handleEnvelope);
    },
    stop() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  };
}
