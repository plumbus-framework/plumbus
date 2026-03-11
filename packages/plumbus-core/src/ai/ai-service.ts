// ── AI Service Implementation ──
// Full ctx.ai implementation: generate, extract, classify, retrieve
// Integrates: provider adapter, prompt registry, validation, cost tracking, security, RAG, explainability

import { z } from 'zod';
import type { AIDocument, AIService } from '../types/context.js';
import type { CostTracker } from './cost-tracker.js';
import { estimateCost } from './cost-tracker.js';
import type { AIExplainabilityTracker } from './explainability.js';
import type { PromptRegistry } from './prompt-registry.js';
import type { AIProviderAdapter, ProviderRequest } from './provider.js';
import type { RAGPipeline } from './rag/pipeline.js';
import type { AISecurityConfig } from './security.js';
import { checkPromptSecurity } from './security.js';
import { generateWithValidation, type ValidationRetryConfig } from './validation.js';

// ── AI Service Config ──
export interface AIServiceConfig {
  provider: AIProviderAdapter;
  promptRegistry?: PromptRegistry;
  costTracker?: CostTracker;
  ragPipeline?: RAGPipeline;
  explainability?: AIExplainabilityTracker;
  security?: AISecurityConfig;
  validation?: ValidationRetryConfig;
  /** Default model name */
  defaultModel?: string;
  /** Budget enforcement settings */
  budget?: {
    tenantId?: string;
    actor?: string;
  };
}

export function createAIService(config: AIServiceConfig): AIService {
  const { provider, promptRegistry, costTracker, ragPipeline, explainability, security } = config;

  function checkBudget(estimatedTokens?: number): void {
    if (!costTracker) return;
    const result = costTracker.checkBudget({
      tenantId: config.budget?.tenantId,
      estimatedTokens,
    });
    if (!result.allowed) {
      throw new Error(`AI budget exceeded: ${result.reason}`);
    }
  }

  function buildPromptText(
    promptName: string,
    input: Record<string, unknown>,
  ): {
    text: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  } {
    if (!promptRegistry) {
      // No registry — treat promptName as raw prompt text
      return { text: promptName };
    }
    const def = promptRegistry.get(promptName);
    // Validate input against prompt input schema
    def.input.parse(input);

    // Resolve template: replace {{key}} with input values
    let text = promptName;
    if (def.description) {
      text = def.description;
    }
    // Simple template resolution: replace {{key}} placeholders
    for (const [key, value] of Object.entries(input)) {
      text = text.replaceAll(`{{${key}}}`, String(value));
    }

    return {
      text,
      model: def.model?.name,
      temperature: def.model?.temperature,
      maxTokens: def.model?.maxTokens,
    };
  }

  return {
    async generate(params: { prompt: string; input: Record<string, unknown> }): Promise<unknown> {
      const start = performance.now();

      // Security check
      const securityResult = security ? checkPromptSecurity(params.input, security) : undefined;
      const inputForAI = securityResult?.redactedInput ?? params.input;

      // Budget pre-check
      checkBudget();

      // Build prompt
      const hasPromptDef = promptRegistry?.has(params.prompt);
      const promptInfo = hasPromptDef
        ? buildPromptText(params.prompt, inputForAI)
        : { text: params.prompt };

      // Check if we have a schema to validate against
      const promptDef = hasPromptDef ? promptRegistry?.get(params.prompt) : undefined;

      const request: ProviderRequest = {
        prompt:
          Object.keys(inputForAI).length > 0
            ? `${promptInfo.text}\n\nInput: ${JSON.stringify(inputForAI)}`
            : promptInfo.text,
        model: promptInfo.model ?? config.defaultModel,
        temperature: promptInfo.temperature,
        maxTokens: promptInfo.maxTokens,
      };

      let result: unknown;
      let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let validationAttempts = 1;
      const validationPassed = true;

      if (promptDef) {
        // Use validated generation
        const validated = await generateWithValidation(
          provider,
          request,
          promptDef.output,
          config.validation,
        );
        result = validated.data;
        totalUsage = validated.usage;
        validationAttempts = validated.attempts;
      } else {
        // Raw generation
        const response = await provider.complete(request);
        result = response.content;
        totalUsage = response.usage;
      }

      const latencyMs = performance.now() - start;

      // Track cost
      if (costTracker) {
        costTracker.record({
          model: promptInfo.model ?? config.defaultModel ?? provider.name,
          promptName: hasPromptDef ? params.prompt : undefined,
          operation: 'generate',
          usage: totalUsage,
          estimatedCost: estimateCost(
            promptInfo.model ?? config.defaultModel ?? provider.name,
            totalUsage,
          ),
          latencyMs,
          tenantId: config.budget?.tenantId,
          actor: config.budget?.actor,
        });
      }

      // Explainability
      if (explainability) {
        explainability.record({
          operation: 'generate',
          promptName: hasPromptDef ? params.prompt : undefined,
          model: promptInfo.model ?? config.defaultModel,
          input: params.input,
          output: result,
          usage: totalUsage,
          validation: {
            passed: validationPassed,
            attempts: validationAttempts,
          },
          securityWarnings: securityResult?.warnings.map((w) => w.message),
          actor: config.budget?.actor,
          tenantId: config.budget?.tenantId,
          latencyMs,
        });
      }

      return result;
    },

    async extract(params: { schema: z.ZodTypeAny; text: string }): Promise<unknown> {
      const start = performance.now();

      checkBudget();

      const systemPrompt =
        'Extract structured data from the following text. Return valid JSON matching the required schema.';
      const request: ProviderRequest = {
        system: systemPrompt,
        prompt: params.text,
        model: config.defaultModel,
        responseFormat: 'json',
      };

      const validated = await generateWithValidation(
        provider,
        request,
        params.schema,
        config.validation,
      );

      const latencyMs = performance.now() - start;

      if (costTracker) {
        costTracker.record({
          model: config.defaultModel ?? provider.name,
          operation: 'extract',
          usage: validated.usage,
          estimatedCost: estimateCost(config.defaultModel ?? provider.name, validated.usage),
          latencyMs,
          tenantId: config.budget?.tenantId,
          actor: config.budget?.actor,
        });
      }

      if (explainability) {
        explainability.record({
          operation: 'extract',
          model: config.defaultModel,
          input: { text: params.text },
          output: validated.data,
          usage: validated.usage,
          validation: { passed: true, attempts: validated.attempts },
          actor: config.budget?.actor,
          tenantId: config.budget?.tenantId,
          latencyMs,
        });
      }

      return validated.data;
    },

    async classify(params: { labels: string[]; text: string }): Promise<string[]> {
      const start = performance.now();

      checkBudget();

      const systemPrompt =
        'Classify the following text into one or more of the provided labels. Return a JSON array of matching label strings.';
      const request: ProviderRequest = {
        system: systemPrompt,
        prompt: `Labels: ${JSON.stringify(params.labels)}\n\nText: ${params.text}`,
        model: config.defaultModel,
        responseFormat: 'json',
      };

      const schema = z.array(z.string());
      const validated = await generateWithValidation(provider, request, schema, config.validation);

      const latencyMs = performance.now() - start;

      // Filter to only valid labels
      const result = validated.data.filter((l: string) => params.labels.includes(l));

      if (costTracker) {
        costTracker.record({
          model: config.defaultModel ?? provider.name,
          operation: 'classify',
          usage: validated.usage,
          estimatedCost: estimateCost(config.defaultModel ?? provider.name, validated.usage),
          latencyMs,
          tenantId: config.budget?.tenantId,
          actor: config.budget?.actor,
        });
      }

      if (explainability) {
        explainability.record({
          operation: 'classify',
          model: config.defaultModel,
          input: { labels: params.labels, text: params.text },
          output: result,
          usage: validated.usage,
          validation: { passed: true, attempts: validated.attempts },
          actor: config.budget?.actor,
          tenantId: config.budget?.tenantId,
          latencyMs,
        });
      }

      return result;
    },

    async retrieve(params: { query: string }): Promise<AIDocument[]> {
      if (!ragPipeline) {
        throw new Error('RAG pipeline not configured — cannot perform retrieval');
      }

      const start = performance.now();

      checkBudget();

      const results = await ragPipeline.retrieve({
        query: params.query,
        tenantId: config.budget?.tenantId,
      });

      const latencyMs = performance.now() - start;

      if (explainability) {
        explainability.record({
          operation: 'retrieve',
          input: { query: params.query },
          output: results,
          retrievalSources: results,
          actor: config.budget?.actor,
          tenantId: config.budget?.tenantId,
          latencyMs,
        });
      }

      return results;
    },
  };
}
