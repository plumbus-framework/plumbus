import type { z } from 'zod';
import type { BackoffStrategy, FlowStepType } from './enums.js';

// ── Flow Steps ──
export interface BaseFlowStep {
  name: string;
}

export interface CapabilityStep extends BaseFlowStep {
  type: typeof FlowStepType.Capability;
}

export interface ConditionalStep extends BaseFlowStep {
  type: typeof FlowStepType.Conditional;
  if: string;
  then: string;
  else?: string;
}

export interface WaitStep extends BaseFlowStep {
  type: typeof FlowStepType.Wait;
  event: string;
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
  event: string;
}

export type FlowStep =
  | CapabilityStep
  | ConditionalStep
  | WaitStep
  | DelayStep
  | ParallelStep
  | EventEmitStep;

// ── Flow Retry Policy ──
export interface FlowRetryPolicy {
  attempts: number;
  backoff: BackoffStrategy;
}

// ── Flow Trigger ──
export interface FlowTrigger {
  event: string;
}

// ── Flow Schedule ──
export interface FlowSchedule {
  cron: string;
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
}
