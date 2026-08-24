// ── Flows Module ──
// Multi-step workflow engine: state machine, step executor, flow engine,
// triggers, scheduler, dead-letter handling, and flow service (ctx.flow).
// Supports capability steps, conditionals, delays, waits, parallel, and event-emit steps.
//
// Key exports: createFlowEngine, createFlowService, FlowRegistry, simulateFlow (in testing)

// ── Flow Registry ──
export { FlowRegistry } from './registry.js';

// ── Compiled definitions ──
export {
  CompiledFlowRegistry,
  DEFAULT_COMPILED_FLOWS_DIRECTORY,
  loadCompiledFlowRegistryFromDirectory,
  tryLoadCompiledFlowRegistryFromDirectory,
} from './compiled-registry.js';
export {
  COMPILED_FLOW_CONTRACT_VERSION,
  compileFlowDefinition,
  flowDefinitionId,
  hydrateCompiledFlow,
} from './compile-flow.js';
export type { CompileFlowOptions } from './compile-flow.js';
export {
  DEFINITION_STRATEGY_NOT_SUPPORTED,
  DefinitionInFlightStrategy,
  DefinitionStrategyNotSupportedError,
  assertSupportedDefinitionStrategy,
} from './definition-strategy.js';
export type { DefinitionInFlightStrategy as DefinitionInFlightStrategyName } from './definition-strategy.js';

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

// ── Flow condition evaluation ──
export {
  evaluateFlowCondition,
  FlowConditionError,
  FLOW_CONDITION_SYNTAX_HINT,
  normalizeFlowConditionExpression,
} from './evaluate-condition.js';

// ── Flow Step Executor ──
export { buildHistoryEntry, executeStep } from './step-executor.js';
export type { StepExecutorDeps, StepResult } from './step-executor.js';

// ── Flow Engine ──
export { computeRetryDelay, createFlowEngine, generateWorkerId } from './engine.js';
export type { FlowEngineConfig, FlowSpineDispatchConfig } from './engine.js';

// ── Flow Triggers ──
export { createFlowTriggerHandler } from './triggers.js';

// ── Flow Scheduler ──
export {
  DEFAULT_SCHEDULE_CATCH_UP_MAX,
  computeNextRun,
  createFlowScheduler,
  planMissedSchedule,
} from './scheduler.js';
export type { MissedSchedulePlan, SchedulerConfig } from './scheduler.js';

// ── ctx.flow Service ──
export { createFlowService } from './flow-service.js';

// ── Dead Letter ──
export { deadLetterFlow, retryDeadLetteredFlow, sweepFailedFlows } from './dead-letter.js';
export type { OperatorRetryOptions, OperatorRetryResult } from './dead-letter.js';

export {
  BUDGET_EXHAUSTED,
  BUDGET_STATE_KEY,
  BudgetExhaustedError,
  chargeExecutionBudget,
  consumeExecutionBudget,
  createExecutionBudgetLedger,
  readExecutionBudget,
  writeExecutionBudget,
} from './budget.js';
export type { ExecutionBudgetAmount, ExecutionBudgetLedger } from './budget.js';
