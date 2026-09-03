import type { z } from 'zod';
import type { BackoffStrategy, FlowStepType } from './enums.js';
import type { RegisteredCapabilityName, RegisteredEventName } from './registry.js';

// ── Flow Steps ──
export interface BaseFlowStep {
  name: string;
}

export interface CapabilityStep extends BaseFlowStep {
  type: typeof FlowStepType.Capability;
  capability?: RegisteredCapabilityName;
  input?: Record<string, unknown>;
  /** Capability to run if this step committed and the flow is cancelled. */
  compensate?: RegisteredCapabilityName;
}

export interface ConditionalStep extends BaseFlowStep {
  type: typeof FlowStepType.Conditional;
  if: string;
  then: string;
  else?: string;
}

export interface WaitStep extends BaseFlowStep {
  type: typeof FlowStepType.Wait;
  event: RegisteredEventName;
}

export interface DelayStep extends BaseFlowStep {
  type: typeof FlowStepType.Delay;
  duration: string;
}

export interface ParallelStep extends BaseFlowStep {
  type: typeof FlowStepType.Parallel;
  branches: string[];
}

export interface EventEmitStep extends BaseFlowStep {
  type: typeof FlowStepType.EventEmit;
  event: RegisteredEventName;
}

/** Routes keyed by `ApprovalDecisionOutcome`. */
export interface ApprovalOutcomeRoutes {
  approved?: string;
  rejected?: string;
  'changes-requested'?: string;
}

export interface ApprovalOutcomeStep extends BaseFlowStep {
  type: typeof FlowStepType.ApprovalOutcome;
  outcomes: ApprovalOutcomeRoutes;
}

export type FlowStep =
  | CapabilityStep
  | ConditionalStep
  | WaitStep
  | DelayStep
  | ParallelStep
  | EventEmitStep
  | ApprovalOutcomeStep;

// ── Flow Retry Policy ──
export interface FlowRetryPolicy {
  attempts: number;
  backoff: BackoffStrategy;
}

// ── Flow Trigger ──
export interface FlowTrigger {
  event: RegisteredEventName;
}

// ── Flow Schedule ──
/** v1 catch-up/skip for missed ticks (trigger-definition catchUpPolicy subset). */
export const ScheduleCatchUpPolicy = {
  Skip: 'skip',
  RunOnce: 'run-once',
  CatchUp: 'catch-up',
} as const;

export type ScheduleCatchUpPolicy =
  (typeof ScheduleCatchUpPolicy)[keyof typeof ScheduleCatchUpPolicy];

/** Per-execution budget v1. */
export interface FlowBudget {
  profileId: string;
  allocated: number;
  unitId?: string;
  dimensionId?: string;
}

export interface FlowSchedule {
  cron: string;
  /**
   * Where the schedule row lives and whose data plane the run gets. `tenants` (the default
   * when the pool has schedule planes) puts one row in every tenant plane and starts the flow
   * with that tenant on auth; `spine` keeps one row on the pool database and starts the flow
   * untenanted. A host with no schedule planes runs everything on the pool.
   */
  plane?: 'spine' | 'tenants';
  /**
   * Missed-tick policy. Default `skip` (one start, jump to the next future
   * slot — no unbounded backlog). `catch-up` starts once per missed slot
   * up to a bound.
   */
  catchUpPolicy?: ScheduleCatchUpPolicy;
}

// ── Flow Definition ──
export interface FlowDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TState extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  domain: string;
  description?: string;
  tags?: string[];

  input: TInput;
  state?: TState;
  steps: FlowStep[];

  trigger?: FlowTrigger;
  schedule?: FlowSchedule;
  retry?: FlowRetryPolicy;

  /**
   * Authoring version used when compiling (`plumbus compile-flows`).
   * Defaults to `"1"` if omitted. Not a runtime pin — executions pin
   * `definitionVersion` from the compiled registry at start.
   */
  version?: string;

  /** Per-execution budget. Stored on execution state as `__budget`. */
  budget?: FlowBudget;
}

/** Kind of hoisted binding in a compiled (signed) flow definition. */
export type CompiledBindingKind = 'condition' | 'input-mapping';

/**
 * Named, individually digested binding. Inline expressions are prohibited
 * in the signed artifact; the compiler hoists them here.
 */
export interface CompiledBinding {
  bindingId: string;
  kind: CompiledBindingKind;
  source: string;
  digest: string;
}

/**
 * Step shape in the signed artifact. Condition expressions and step IO
 * mappings are binding ids, not inline code.
 */
export interface CompiledFlowStep {
  name: string;
  type: FlowStepType;
  capability?: string;
  compensate?: string;
  inputBindingId?: string;
  conditionBindingId?: string;
  then?: string;
  else?: string;
  event?: string;
  duration?: string;
  branches?: string[];
  outcomes?: ApprovalOutcomeRoutes;
}

/**
 * Compiled, digest-addressed flow definition (v1 subset).
 * The live TypeScript `FlowDefinition` remains the authoring model.
 */
export interface CompiledFlowDefinition {
  contractVersion: '0.1.0';
  flowDefinitionId: string;
  definitionVersion: string;
  definitionDigest: string;
  domain: string;
  name: string;
  description?: string;
  steps: CompiledFlowStep[];
  bindings: CompiledBinding[];
  trigger?: FlowTrigger;
  schedule?: FlowSchedule;
  retry?: FlowRetryPolicy;
}
