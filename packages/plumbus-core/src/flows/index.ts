// ── Flows Module ──
// Multi-step workflow engine: state machine, step executor, flow engine,
// triggers, scheduler, dead-letter handling, and flow service (ctx.flow).
// Supports capability steps, conditionals, delays, waits, parallel, and event-emit steps.
//
// Key exports: createFlowEngine, createFlowService, FlowRegistry, simulateFlow (in testing)

// ── Flow Registry ──
export { FlowRegistry } from './registry.js';

// ── Flow State Machine ──
export {
  FlowStatus,
  StepStatus,
  assertTransition,
  isTerminal,
  isValidTransition,
} from './state-machine.js';
export type { StepHistoryEntry } from './state-machine.js';

// ── Flow Schemas (Drizzle tables) ──
export {
  flowDeadLetterTable,
  flowExecutionsTable,
  flowSchedulesTable,
} from './schema.js';

// ── Flow Step Executor ──
export { buildHistoryEntry, executeStep } from './step-executor.js';
export type { StepExecutorDeps, StepResult } from './step-executor.js';

// ── Flow Engine ──
export { computeRetryDelay, createFlowEngine } from './engine.js';
export type { FlowEngineConfig } from './engine.js';

// ── Flow Triggers ──
export { createFlowTriggerHandler } from './triggers.js';

// ── Flow Scheduler ──
export { computeNextRun, createFlowScheduler } from './scheduler.js';
export type { SchedulerConfig } from './scheduler.js';

// ── ctx.flow Service ──
export { createFlowService } from './flow-service.js';

// ── Dead Letter ──
export { deadLetterFlow, sweepFailedFlows } from './dead-letter.js';
