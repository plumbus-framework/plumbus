// ── Capability dependency governance rules ──

import {
  getCanonicalCapabilityName,
  isCanonicalCapabilityName,
} from '../../execution/canonical-name.js';
import type { CapabilityContract } from '../../types/capability.js';
import { CapabilityKind, FlowStepType, GovernanceSeverity } from '../../types/enums.js';
import type { GovernanceRule } from '../rule-engine.js';

const DEEP_CHAIN_THRESHOLD = 3;

function buildDeclaredGraph(capabilities: CapabilityContract[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const cap of capabilities) {
    graph.set(getCanonicalCapabilityName(cap), cap.effects.capabilities ?? []);
  }
  return graph;
}

function registeredCanonicalNames(capabilities: CapabilityContract[]): Set<string> {
  return new Set(capabilities.map((c) => getCanonicalCapabilityName(c)));
}

function maxDeclaredDepth(graph: Map<string, string[]>, start: string): number {
  const visited = new Set<string>();
  function dfs(node: string): number {
    if (visited.has(node)) return 0;
    visited.add(node);
    const deps = graph.get(node) ?? [];
    if (deps.length === 0) return 1;
    return 1 + Math.max(...deps.map((d) => dfs(d)));
  }
  return dfs(start);
}

function findDeclaredCycle(graph: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): string[] | null {
    if (visiting.has(node)) {
      const cycleStart = stack.indexOf(node);
      return cycleStart >= 0 ? [...stack.slice(cycleStart), node] : [node, node];
    }
    if (visited.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }

  for (const node of graph.keys()) {
    const cycle = dfs(node);
    if (cycle) return cycle;
  }
  return null;
}

export const ruleMissingCapabilityDependency: GovernanceRule = {
  id: 'architecture.missing-capability-dependency',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'Declared capability dependencies must reference registered capabilities',
  evaluate(inventory) {
    const registered = registeredCanonicalNames(inventory.capabilities);
    const signals = [];
    for (const cap of inventory.capabilities) {
      for (const dep of cap.effects.capabilities ?? []) {
        if (!registered.has(dep)) {
          signals.push({
            severity: GovernanceSeverity.Warning,
            rule: 'architecture.missing-capability-dependency',
            description: `Capability "${getCanonicalCapabilityName(cap)}" declares dependency "${dep}" which is not registered`,
            affectedComponent: `capability:${getCanonicalCapabilityName(cap)}`,
            remediation: `Register capability "${dep}" or remove it from effects.capabilities`,
          });
        }
      }
    }
    return signals;
  },
};

export const ruleCircularCapabilityDependency: GovernanceRule = {
  id: 'architecture.circular-capability-dependency',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'Declared capability dependency graph must not contain cycles',
  evaluate(inventory) {
    const graph = buildDeclaredGraph(inventory.capabilities);
    const cycle = findDeclaredCycle(graph);
    if (!cycle) return [];
    return [
      {
        severity: GovernanceSeverity.Warning,
        rule: 'architecture.circular-capability-dependency',
        description: `Circular capability dependency detected: ${cycle.join(' -> ')}`,
        affectedComponent: `capability:${cycle[0] ?? 'unknown'}`,
        remediation: 'Break the cycle by extracting shared logic or using a flow for orchestration',
      },
    ];
  },
};

export const ruleDeepCapabilityChain: GovernanceRule = {
  id: 'architecture.deep-capability-chain',
  category: 'architecture',
  severity: GovernanceSeverity.Info,
  description: 'Deep declared capability chains may be better modeled as flows',
  evaluate(inventory) {
    const graph = buildDeclaredGraph(inventory.capabilities);
    return inventory.capabilities
      .filter((cap) => {
        const canonical = getCanonicalCapabilityName(cap);
        return maxDeclaredDepth(graph, canonical) >= DEEP_CHAIN_THRESHOLD;
      })
      .map((cap) => ({
        severity: GovernanceSeverity.Info,
        rule: 'architecture.deep-capability-chain',
        description: `Capability "${getCanonicalCapabilityName(cap)}" has a declared dependency chain depth >= ${DEEP_CHAIN_THRESHOLD}`,
        affectedComponent: `capability:${getCanonicalCapabilityName(cap)}`,
        remediation:
          'Consider a flow for multi-step orchestration instead of deep nested invocation',
      }));
  },
};

export const ruleNonCanonicalCapabilityReference: GovernanceRule = {
  id: 'architecture.non-canonical-capability-reference',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'Capability references must use canonical <domain>.<name> format',
  evaluate(inventory) {
    const signals = [];
    for (const cap of inventory.capabilities) {
      for (const dep of cap.effects.capabilities ?? []) {
        if (!isCanonicalCapabilityName(dep)) {
          signals.push({
            severity: GovernanceSeverity.Warning,
            rule: 'architecture.non-canonical-capability-reference',
            description: `Capability "${getCanonicalCapabilityName(cap)}" references non-canonical dependency "${dep}"`,
            affectedComponent: `capability:${getCanonicalCapabilityName(cap)}`,
            remediation: 'Use canonical format <domain>.<capabilityName> in effects.capabilities',
          });
        }
      }
    }
    for (const flow of inventory.flows) {
      for (const step of flow.steps) {
        if (step.type === FlowStepType.Capability && step.capability) {
          if (!isCanonicalCapabilityName(step.capability)) {
            signals.push({
              severity: GovernanceSeverity.Warning,
              rule: 'architecture.non-canonical-capability-reference',
              description: `Flow "${flow.name}" step "${step.name}" references non-canonical capability "${step.capability}"`,
              affectedComponent: `flow:${flow.name}`,
              remediation: 'Use canonical format <domain>.<capabilityName> in flow step.capability',
            });
          }
        }
      }
    }
    return signals;
  },
};

export const ruleJobCapabilityDependency: GovernanceRule = {
  id: 'architecture.job-capability-dependency',
  category: 'architecture',
  severity: GovernanceSeverity.Warning,
  description: 'Job capabilities cannot be invoked synchronously via ctx.capabilities.invoke',
  evaluate(inventory) {
    const jobNames = new Set(
      inventory.capabilities
        .filter((c) => c.kind === CapabilityKind.Job)
        .map((c) => getCanonicalCapabilityName(c)),
    );
    const signals = [];
    for (const cap of inventory.capabilities) {
      for (const dep of cap.effects.capabilities ?? []) {
        if (jobNames.has(dep)) {
          signals.push({
            severity: GovernanceSeverity.Warning,
            rule: 'architecture.job-capability-dependency',
            description: `Capability "${getCanonicalCapabilityName(cap)}" declares job capability "${dep}" as a synchronous dependency`,
            affectedComponent: `capability:${getCanonicalCapabilityName(cap)}`,
            remediation:
              'Use job dispatch, flows, or events instead of nested invoke for job capabilities',
          });
        }
      }
    }
    return signals;
  },
};

export const capabilityDependencyRules: GovernanceRule[] = [
  ruleMissingCapabilityDependency,
  ruleCircularCapabilityDependency,
  ruleDeepCapabilityChain,
  ruleNonCanonicalCapabilityReference,
  ruleJobCapabilityDependency,
];
