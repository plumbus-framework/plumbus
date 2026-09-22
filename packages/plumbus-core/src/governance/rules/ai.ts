// ── Built-in AI Governance Rules ──

import { GovernanceSeverity } from '../../types/enums.js';
import type { GovernanceRule } from '../rule-engine.js';

/** Prompts without output validation schemas */
export const rulePromptMissingOutputSchema: GovernanceRule = {
  id: 'ai.prompt-missing-output-schema',
  category: 'ai',
  severity: GovernanceSeverity.Warning,
  description: 'Prompts should define output schemas for validated responses',
  evaluate(inventory) {
    return inventory.prompts
      .filter((prompt) => !prompt.output)
      .map((prompt) => ({
        severity: GovernanceSeverity.Warning,
        rule: 'ai.prompt-missing-output-schema',
        description: `Prompt "${prompt.name}" has no output schema defined`,
        affectedComponent: `prompt:${prompt.name}`,
        remediation: 'Add an output Zod schema to enable response validation',
      }));
  },
};

/** Prompts without model configuration */
export const rulePromptMissingModelConfig: GovernanceRule = {
  id: 'ai.prompt-missing-model-config',
  category: 'ai',
  severity: GovernanceSeverity.Info,
  description: 'Prompts should specify model configuration for reproducibility',
  evaluate(inventory) {
    return inventory.prompts
      .filter((prompt) => !prompt.model)
      .map((prompt) => ({
        severity: GovernanceSeverity.Info,
        rule: 'ai.prompt-missing-model-config',
        description: `Prompt "${prompt.name}" has no model configuration — default will be used`,
        affectedComponent: `prompt:${prompt.name}`,
        remediation: 'Add a model configuration (provider, name, temperature, maxTokens)',
      }));
  },
};

/** Capabilities using AI without explanation enabled */
export const ruleAIWithoutExplanation: GovernanceRule = {
  id: 'ai.missing-explanation',
  category: 'ai',
  severity: GovernanceSeverity.Warning,
  description: 'Capabilities using AI should enable explanation tracking',
  evaluate(inventory) {
    return inventory.capabilities
      .filter((cap) => cap.effects.ai && !cap.explanation?.enabled)
      .map((cap) => ({
        severity: GovernanceSeverity.Warning,
        rule: 'ai.missing-explanation',
        description: `Capability "${cap.name}" uses AI but does not have explanation tracking enabled`,
        affectedComponent: `capability:${cap.name}`,
        remediation: 'Add `explanation: { enabled: true }` to the capability contract',
      }));
  },
};

/** Excessive AI usage — too many capabilities relying on AI */
export const ruleExcessiveAIUsage: GovernanceRule = {
  id: 'ai.excessive-usage',
  category: 'ai',
  severity: GovernanceSeverity.Info,
  description: 'A high proportion of capabilities using AI may indicate over-reliance',
  evaluate(inventory) {
    if (inventory.capabilities.length === 0) return [];
    const aiCount = inventory.capabilities.filter((c) => c.effects.ai).length;
    const ratio = aiCount / inventory.capabilities.length;
    if (ratio > 0.7 && aiCount > 3) {
      return [
        {
          severity: GovernanceSeverity.Info,
          rule: 'ai.excessive-usage',
          description: `${aiCount} of ${inventory.capabilities.length} capabilities (${Math.round(ratio * 100)}%) use AI — consider if all need AI`,
          affectedComponent: 'system',
          remediation: 'Review capabilities to ensure AI is being used where it adds genuine value',
        },
      ];
    }
    return [];
  },
};

export const aiRules: GovernanceRule[] = [
  rulePromptMissingOutputSchema,
  rulePromptMissingModelConfig,
  ruleAIWithoutExplanation,
  ruleExcessiveAIUsage,
];
