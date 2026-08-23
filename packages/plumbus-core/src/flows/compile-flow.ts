// Compile defineFlow authoring objects into a signed FlowDefinition JSON
// artifact (Plan 02 Stage 5 / D-02-2). Inline condition expressions and
// step IO mappings are hoisted into individually digested bindings.
// The existing flow engine hydrates these back to FlowStep[] — this is
// not a second workflow engine.

import { createHash } from 'node:crypto';
import { FlowStepType } from '../types/enums.js';
import type {
  CompiledBinding,
  CompiledFlowDefinition,
  CompiledFlowStep,
  FlowDefinition,
  FlowStep,
} from '../types/flow.js';

export const COMPILED_FLOW_CONTRACT_VERSION = '0.1.0' as const;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 of canonical JSON (key-sorted). Used for definition and binding digests. */
export function digestCanonicalJson(value: unknown): string {
  const json = JSON.stringify(sortKeys(value));
  return createHash('sha256').update(json).digest('hex');
}

/** Stable identity: `{domain}.{name}`. */
export function flowDefinitionId(flow: { domain: string; name: string }): string {
  return `${flow.domain}.${flow.name}`;
}

function bindingId(id: string, kind: CompiledBinding['kind'], stepName: string): string {
  return `${id}:${kind}:${stepName}`;
}

function hoistBinding(
  bindings: CompiledBinding[],
  id: string,
  kind: CompiledBinding['kind'],
  stepName: string,
  source: string,
): string {
  const compiled: CompiledBinding = {
    bindingId: bindingId(id, kind, stepName),
    kind,
    source,
    digest: digestCanonicalJson(source),
  };
  bindings.push(compiled);
  return compiled.bindingId;
}

function compileStep(step: FlowStep, id: string, bindings: CompiledBinding[]): CompiledFlowStep {
  const compiled: CompiledFlowStep = { name: step.name, type: step.type };

  if (step.type === FlowStepType.Capability) {
    if (step.capability) compiled.capability = step.capability;
    if (step.compensate) compiled.compensate = step.compensate;
    if (step.input) {
      compiled.inputBindingId = hoistBinding(
        bindings,
        id,
        'input-mapping',
        step.name,
        JSON.stringify(sortKeys(step.input)),
      );
    }
    return compiled;
  }

  if (step.type === FlowStepType.Conditional) {
    compiled.conditionBindingId = hoistBinding(bindings, id, 'condition', step.name, step.if);
    compiled.then = step.then;
    if (step.else) compiled.else = step.else;
    return compiled;
  }

  if (step.type === FlowStepType.Wait || step.type === FlowStepType.EventEmit) {
    compiled.event = step.event;
    return compiled;
  }

  if (step.type === FlowStepType.Delay) {
    compiled.duration = step.duration;
    return compiled;
  }

  if (step.type === FlowStepType.Parallel) {
    compiled.branches = [...step.branches];
    return compiled;
  }

  if (step.type === FlowStepType.ApprovalOutcome) {
    compiled.outcomes = { ...step.outcomes };
    return compiled;
  }

  return compiled;
}

export interface CompileFlowOptions {
  definitionVersion?: string;
}

/**
 * Compile a live `defineFlow` object into a signed artifact.
 * Recompiling an identical flow yields the same `definitionDigest`.
 */
export function compileFlowDefinition(
  flow: FlowDefinition,
  options?: CompileFlowOptions,
): CompiledFlowDefinition {
  const id = flowDefinitionId(flow);
  const definitionVersion = options?.definitionVersion ?? flow.version ?? '1';
  const bindings: CompiledBinding[] = [];
  const steps = flow.steps.map((step) => compileStep(step, id, bindings));

  const unsigned: Omit<CompiledFlowDefinition, 'definitionDigest'> = {
    contractVersion: COMPILED_FLOW_CONTRACT_VERSION,
    flowDefinitionId: id,
    definitionVersion,
    domain: flow.domain,
    name: flow.name,
    steps,
    bindings,
  };
  if (flow.description) unsigned.description = flow.description;
  if (flow.trigger) unsigned.trigger = flow.trigger;
  if (flow.schedule) unsigned.schedule = flow.schedule;
  if (flow.retry) unsigned.retry = flow.retry;

  return {
    ...unsigned,
    definitionDigest: digestCanonicalJson(unsigned),
  };
}

function bindingSource(
  compiled: CompiledFlowDefinition,
  bindingId: string | undefined,
): string | undefined {
  if (!bindingId) return undefined;
  return compiled.bindings.find((b) => b.bindingId === bindingId)?.source;
}

/**
 * Reconstruct live `FlowStep[]` from a compiled artifact, keeping Zod
 * schemas and metadata from the authoring `FlowDefinition`.
 */
export function hydrateCompiledFlow(
  compiled: CompiledFlowDefinition,
  authoring: FlowDefinition,
): FlowDefinition {
  const steps: FlowStep[] = compiled.steps.map((step) => {
    if (step.type === FlowStepType.Capability) {
      const source = bindingSource(compiled, step.inputBindingId);
      return {
        name: step.name,
        type: FlowStepType.Capability,
        ...(step.capability ? { capability: step.capability } : {}),
        ...(step.compensate ? { compensate: step.compensate } : {}),
        ...(source ? { input: JSON.parse(source) as Record<string, unknown> } : {}),
      };
    }
    if (step.type === FlowStepType.Conditional) {
      return {
        name: step.name,
        type: FlowStepType.Conditional,
        if: bindingSource(compiled, step.conditionBindingId) ?? '',
        then: step.then ?? '',
        ...(step.else ? { else: step.else } : {}),
      };
    }
    if (step.type === FlowStepType.Wait) {
      return { name: step.name, type: FlowStepType.Wait, event: step.event ?? '' };
    }
    if (step.type === FlowStepType.EventEmit) {
      return { name: step.name, type: FlowStepType.EventEmit, event: step.event ?? '' };
    }
    if (step.type === FlowStepType.Delay) {
      return { name: step.name, type: FlowStepType.Delay, duration: step.duration ?? '0s' };
    }
    if (step.type === FlowStepType.Parallel) {
      return { name: step.name, type: FlowStepType.Parallel, branches: step.branches ?? [] };
    }
    if (step.type === FlowStepType.ApprovalOutcome) {
      return {
        name: step.name,
        type: FlowStepType.ApprovalOutcome,
        outcomes: step.outcomes ?? {},
      };
    }
    return { name: step.name, type: FlowStepType.Capability };
  });

  return {
    ...authoring,
    name: compiled.name,
    domain: compiled.domain,
    description: compiled.description ?? authoring.description,
    steps,
    trigger: compiled.trigger ?? authoring.trigger,
    schedule: compiled.schedule ?? authoring.schedule,
    retry: compiled.retry ?? authoring.retry,
    version: compiled.definitionVersion,
  };
}
