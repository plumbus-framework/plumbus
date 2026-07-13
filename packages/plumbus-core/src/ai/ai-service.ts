// ── AI Service Implementation ──
// Full ctx.ai implementation: generate, extract, classify, retrieve
// Integrates: provider adapter, prompt registry, validation, cost tracking, security, RAG, explainability

import { z } from 'zod';
import { AIBudgetExceededError, AISecurityBlockedError } from '../errors/data-errors.js';
import type {
  AICostContext,
  AIDocument,
  AIGenerateResult,
  AIService,
  AIStreamEvent,
} from '../types/context.js';
import type { PromptDefinition } from '../types/prompt.js';
import type { AICostRecord, AICostRecordInput, CostTracker } from './cost-tracker.js';
import type { AIExplainabilityTracker } from './explainability.js';
import { calculateModelCost } from './model-pricing.js';
import type { PromptRegistry } from './prompt-registry.js';
import type { AIProviderAdapter, ChatMessage, ProviderRequest, TokenUsage } from './provider.js';
import type { RAGPipeline } from './rag/pipeline.js';
import { AIIncompleteOutputError, AIRefusalError } from './refusal.js';
import type { AISecurityConfig } from './security.js';
import { checkPromptSecurity } from './security.js';
import {
  AIValidationError,
  generateWithValidation,
  type ValidationRetryConfig,
} from './validation.js';
import { zodToProviderJsonSchema } from './zod-to-provider-schema.js';

// Re-export AICostContext from the public ai module barrel.
export type { AICostContext };

/**
 * Framework-level hook fired after every AI call completes (success or
 * failure) and the in-memory cost tracker has been updated. Consumers wire
 * this in through `ServerConfig.onAICostRecorded` to persist per-call spend
 * to their own ledger (e.g. an app-owned per-project cost ledger).
 */
export type OnAICostRecorded = (
  record: AICostRecord,
  costContext?: AICostContext,
) => Promise<void> | void;

// ── AI Service Config ──
export interface AIServiceConfig {
  /** Multiple provider adapters keyed by name (e.g. "openai", "anthropic") */
  providers: Record<string, AIProviderAdapter>;
  /** Which provider to use when a prompt doesn't specify one */
  defaultProvider: string;
  promptRegistry?: PromptRegistry;
  costTracker?: CostTracker;
  ragPipeline?: RAGPipeline;
  explainability?: AIExplainabilityTracker;
  security?: AISecurityConfig;
  validation?: ValidationRetryConfig;
  /** Default model name */
  defaultModel?: string /** Per-prompt model/provider overrides from config/env */;
  /** Enable provider-side constrained decoding for JSON-output prompt schemas. */
  enableStrictStructuredOutputs?: boolean;
  promptOverrides?: Record<
    string,
    { provider?: string; model?: string; temperature?: number; maxTokens?: number }
  > /** Budget enforcement settings */;
  budget?: {
    tenantId?: string;
    actor?: string;
  };
  /**
   * Optional framework hook fired after every AI call completes and the
   * in-memory cost tracker has been updated. Used by consumer apps to
   * persist a ledger row per AI call (success or failure). Thrown errors
   * in the hook are caught and logged to stderr but never propagate.
   */
  onAICostRecorded?: OnAICostRecorded;
}

/** Convenience: create config from a single provider (backward compat) */
export function singleProviderConfig(
  provider: AIProviderAdapter,
  rest?: Omit<AIServiceConfig, 'providers' | 'defaultProvider'>,
): AIServiceConfig {
  return {
    providers: { [provider.name]: provider },
    defaultProvider: provider.name,
    ...rest,
  };
}

export function createAIService(config: AIServiceConfig): AIService {
  const {
    providers,
    defaultProvider,
    promptRegistry,
    costTracker,
    ragPipeline,
    explainability,
    security,
    onAICostRecorded,
  } = config;
  const responseSchemaCache = new WeakMap<z.ZodTypeAny, Record<string, unknown>>();

  function resolveProvider(providerName?: string): AIProviderAdapter {
    const name = providerName ?? defaultProvider;
    const adapter = providers[name];
    if (!adapter) {
      const available = Object.keys(providers).join(', ');
      throw new Error(`AI provider "${name}" not configured. Available: ${available}`);
    }
    return adapter;
  }

  function getSingleTextFieldName(schema: z.ZodTypeAny): string | undefined {
    const shape = schema instanceof z.ZodObject ? schema.shape : undefined;
    if (!shape) return undefined;
    const keys = Object.keys(shape);
    const firstKey = keys[0];
    if (keys.length === 1 && firstKey && shape[firstKey] instanceof z.ZodString) {
      return firstKey;
    }
    return undefined;
  }

  function getStrictResponseSchema(
    promptName: string,
    promptDef: PromptDefinition | undefined,
  ): Record<string, unknown> | undefined {
    if (!promptDef) return undefined;
    if (!config.enableStrictStructuredOutputs) {
      if (promptDef.requireStrictStructuredOutputs) {
        throw new Error(
          `Prompt "${promptName}" requires provider-side structured outputs, but enableStrictStructuredOutputs is disabled`,
        );
      }
      return undefined;
    }
    if (promptDef.disableStrictStructuredOutputs) {
      if (promptDef.requireStrictStructuredOutputs) {
        throw new Error(
          `Prompt "${promptName}" cannot require strict structured outputs while disableStrictStructuredOutputs is set`,
        );
      }
      return undefined;
    }
    if (getSingleTextFieldName(promptDef.output)) {
      if (promptDef.requireStrictStructuredOutputs) {
        throw new Error(
          `Prompt "${promptName}" requires provider-side structured outputs, but single-string output schemas use text mode`,
        );
      }
      return undefined;
    }

    const cached = responseSchemaCache.get(promptDef.output);
    if (cached) return cached;

    const converted = zodToProviderJsonSchema(promptDef.output, { promptName });
    responseSchemaCache.set(promptDef.output, converted.schema);
    return converted.schema;
  }

  function getTypedAIErrorStatus(err: unknown): 'refused' | 'incomplete' | 'failed' {
    if (err instanceof AIRefusalError) return 'refused';
    if (err instanceof AIIncompleteOutputError) return 'incomplete';
    return 'failed';
  }

  function getTypedAIErrorUsage(err: unknown): TokenUsage | undefined {
    if (err instanceof AIRefusalError || err instanceof AIIncompleteOutputError) {
      return err.usage;
    }
    return undefined;
  }

  /**
   * Centralized cost recorder: updates the in-memory tracker and fires the
   * optional `onAICostRecorded` hook. Hook errors are swallowed so a
   * misbehaving hook can never break the AI call. The `status` default and
   * id/timestamp generation mirror what `createCostTracker` does internally
   * so the hook gets a fully-formed `AICostRecord`.
   */
  async function recordProviderCost(
    entry: AICostRecordInput,
    costContext: AICostContext | undefined,
  ): Promise<void> {
    if (costTracker) {
      costTracker.record(entry);
    }
    if (onAICostRecorded) {
      const finalEntry: AICostRecord = {
        ...entry,
        status: entry.status ?? 'success',
        id: crypto.randomUUID(),
        timestamp: new Date(),
      };
      try {
        await onAICostRecorded(finalEntry, costContext);
      } catch (hookErr) {
        const msg = hookErr instanceof Error ? hookErr.message : String(hookErr);
        console.error(`[plumbus:ai] onAICostRecorded hook threw: ${msg}`);
      }
    }
  }

  function sumUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage {
    const left = a ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const right = b ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    return {
      inputTokens: left.inputTokens + right.inputTokens,
      outputTokens: left.outputTokens + right.outputTokens,
      totalTokens: left.totalTokens + right.totalTokens,
      cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
      cacheWriteTokens: (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0),
    };
  }

  function checkBudget(estimatedTokens?: number, estimatedCostUsd?: number): void {
    if (!costTracker) return;
    const result = costTracker.checkBudget({
      tenantId: config.budget?.tenantId,
      estimatedTokens,
      estimatedCostUsd,
    });
    if (!result.allowed) {
      throw new AIBudgetExceededError(result.reason ?? 'budget exceeded');
    }
  }

  function buildPromptText(
    promptName: string,
    input: Record<string, unknown>,
  ): {
    system?: string;
    text: string;
    model?: string;
    provider?: string;
    temperature?: number;
    maxTokens?: number;
    appendUnsubstitutedInput?: boolean;
    /**
     * Set of input keys that had a `{{key}}` placeholder in the prompt
     * system or description and were therefore inlined into the provider
     * request. Callers should
     * exclude these from any `Input: ${JSON.stringify(...)}` append to
     * avoid sending the same value twice in one request.
     */
    substitutedKeys: Set<string>;
  } {
    if (!promptRegistry) {
      // No registry — treat promptName as raw prompt text
      return { text: promptName, substitutedKeys: new Set() };
    }
    const def = promptRegistry.get(promptName);
    // Validate input against prompt input schema
    def.input.parse(input);

    // Simple template resolution: replace top-level {{key}} placeholders.
    const substitutedKeys = new Set<string>();
    const renderTemplate = (template: string): string => {
      let text = template;
      for (const [key, value] of Object.entries(input)) {
        const placeholder = `{{${key}}}`;
        if (text.includes(placeholder)) {
          substitutedKeys.add(key);
          text = text.replaceAll(placeholder, String(value));
        }
      }
      return text;
    };
    const system = def.system ? renderTemplate(def.system) : undefined;
    const text = renderTemplate(def.description ?? promptName);

    // Resolution chain: config/env override → prompt-level → defaults
    // Look up override by prompt name (dots replaced with underscores for env var matching)
    const overrideKey = promptName.toLowerCase().replaceAll('.', '_');
    const override = config.promptOverrides?.[overrideKey] ?? config.promptOverrides?.[promptName];

    return {
      system,
      text,
      model: override?.model ?? def.model?.name ?? config.defaultModel,
      provider: override?.provider ?? def.model?.provider,
      temperature: override?.temperature ?? def.model?.temperature,
      maxTokens: override?.maxTokens ?? def.model?.maxTokens,
      appendUnsubstitutedInput: def.appendUnsubstitutedInput,
      substitutedKeys,
    };
  }

  /**
   * Builds the final prompt string the provider sees, given a rendered
   * `promptInfo` (with placeholders already substituted) and the original
   * input object. Any keys that were inlined as `{{key}}` in the description
   * are stripped from the appended `Input: ...` JSON blob to prevent the
   * same value from being sent twice in one HTTP body.
   */
  function buildBasePrompt(
    promptInfo: {
      text: string;
      substitutedKeys?: Set<string>;
      appendUnsubstitutedInput?: boolean;
    },
    inputForAI: Record<string, unknown>,
  ): string {
    if (promptInfo.appendUnsubstitutedInput === false) {
      return promptInfo.text;
    }
    const substituted = promptInfo.substitutedKeys ?? new Set<string>();
    const remaining: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputForAI)) {
      if (!substituted.has(key)) {
        remaining[key] = value;
      }
    }
    if (Object.keys(remaining).length === 0) {
      return promptInfo.text;
    }
    return `${promptInfo.text}\n\nInput: ${JSON.stringify(remaining)}`;
  }

  function applyPromptSecurity(input: Record<string, unknown>): {
    inputForAI: Record<string, unknown>;
    securityResult?: ReturnType<typeof checkPromptSecurity>;
  } {
    if (!security) {
      return { inputForAI: input };
    }
    const securityResult = checkPromptSecurity(input, security);
    if (securityResult.blocked) {
      throw new AISecurityBlockedError(securityResult.warnings.map((w) => w.field));
    }
    return {
      inputForAI: securityResult.redactedInput ?? input,
      securityResult,
    };
  }

  // ── Shared generate implementation (returns data + usage) ──
  async function _generateCore(params: {
    prompt: string;
    input: Record<string, unknown>;
    messages?: ChatMessage[];
    validation?: ValidationRetryConfig;
    signal?: AbortSignal;
    costContext?: AICostContext;
    seed?: number;
  }): Promise<AIGenerateResult> {
    const start = performance.now();

    const { inputForAI, securityResult } = applyPromptSecurity(params.input);

    // Budget pre-check
    checkBudget();

    // Build prompt
    const hasPromptDef = promptRegistry?.has(params.prompt);
    const promptInfo = hasPromptDef
      ? buildPromptText(params.prompt, inputForAI)
      : { text: params.prompt, substitutedKeys: new Set<string>() };

    // Resolve provider: prompt-level > default
    const activeProvider = resolveProvider(
      'provider' in promptInfo ? promptInfo.provider : undefined,
    );

    // Check if we have a schema to validate against
    const promptDef = hasPromptDef ? promptRegistry?.get(params.prompt) : undefined;
    const singleTextField = promptDef ? getSingleTextFieldName(promptDef.output) : undefined;
    const responseSchema = getStrictResponseSchema(params.prompt, promptDef);

    const basePrompt = buildBasePrompt(promptInfo, inputForAI);
    const useMultiTurn = Boolean(params.messages && params.messages.length > 0);
    const mergedSystem = useMultiTurn
      ? [promptInfo.system, basePrompt].filter((s) => s && String(s).trim().length > 0).join('\n\n')
      : promptInfo.system;

    const request: ProviderRequest = {
      system: mergedSystem || undefined,
      prompt: useMultiTurn ? '' : basePrompt,
      messages: params.messages,
      model: promptInfo.model ?? config.defaultModel,
      temperature: promptInfo.temperature,
      maxTokens: promptInfo.maxTokens,
      responseFormat: promptDef && !singleTextField ? 'json' : undefined,
      responseSchema,
      structuredOutputTransport: promptDef?.structuredOutputTransport,
      signal: params.signal,
      seed: params.seed,
    };

    const resolvedModel = promptInfo.model ?? config.defaultModel ?? activeProvider.name;

    let result: any;
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let validationAttempts = 1;
    let validationPassed = true;

    try {
      if (promptDef) {
        // Use validated generation
        const validated = await generateWithValidation(activeProvider, request, promptDef.output, {
          ...config.validation,
          ...params.validation,
          model: resolvedModel,
          provider: activeProvider.name,
        });
        result = validated.data;
        totalUsage = validated.usage;
        validationAttempts = validated.attempts;
        validationPassed = validated.attempts === 1;
      } else {
        // Raw generation
        const response = await activeProvider.complete(request);
        result = response.content;
        totalUsage = response.usage;
      }
    } catch (err) {
      // Failure-path cost recording: capture whatever usage we know about
      // (from AIValidationError or zero for opaque fetch errors) so the
      // sunk provider-side spend is still visible to budgets and ledgers.
      const latencyMs = performance.now() - start;
      const failureUsage: TokenUsage =
        err instanceof AIValidationError
          ? err.usage
          : (getTypedAIErrorUsage(err) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      const errorMessage = err instanceof Error ? err.message : String(err);
      const failureCost =
        failureUsage.totalTokens > 0
          ? calculateModelCost(failureUsage.inputTokens, failureUsage.outputTokens, resolvedModel, {
              cachedInputTokens: failureUsage.cachedInputTokens,
              cacheWriteTokens: failureUsage.cacheWriteTokens,
            })
          : null;
      await recordProviderCost(
        {
          model: resolvedModel,
          provider: activeProvider.name,
          promptName: hasPromptDef ? params.prompt : undefined,
          operation: 'generate',
          usage: failureUsage,
          cost: failureCost,
          latencyMs,
          tenantId: config.budget?.tenantId,
          actor: config.budget?.actor,
          status: getTypedAIErrorStatus(err),
          errorMessage,
        },
        params.costContext,
      );
      throw err;
    }

    const latencyMs = performance.now() - start;

    // Track cost (success path)
    await recordProviderCost(
      {
        model: resolvedModel,
        provider: activeProvider.name,
        promptName: hasPromptDef ? params.prompt : undefined,
        operation: 'generate',
        usage: totalUsage,
        cost: null,
        latencyMs,
        tenantId: config.budget?.tenantId,
        actor: config.budget?.actor,
        status: 'success',
      },
      params.costContext,
    );

    // Explainability
    if (explainability) {
      explainability.record({
        operation: 'generate',
        promptName: hasPromptDef ? params.prompt : undefined,
        model: promptInfo.model ?? config.defaultModel,
        provider: activeProvider.name,
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

    const cost = calculateModelCost(
      totalUsage.inputTokens,
      totalUsage.outputTokens,
      resolvedModel,
      {
        cachedInputTokens: totalUsage.cachedInputTokens,
        cacheWriteTokens: totalUsage.cacheWriteTokens,
      },
    );

    return {
      data: result,
      usage: totalUsage,
      model: resolvedModel,
      provider: activeProvider.name,
      cost,
    };
  }

  return {
    recordProviderCost,

    checkProviderCostBudget(config = {}) {
      checkBudget(config.estimatedTokens, config.estimatedCostUsd);
    },

    async generate(params: {
      prompt: string;
      input: Record<string, unknown>;
      messages?: ChatMessage[];
      validation?: ValidationRetryConfig;
      signal?: AbortSignal;
      costContext?: AICostContext;
      seed?: number;
    }): Promise<Record<string, any>> {
      const { data } = await _generateCore(params);
      return data;
    },

    async generateWithUsage(params: {
      prompt: string;
      input: Record<string, unknown>;
      /**
       * Optional native multi-turn conversation history. See `streamGenerate`
       * for semantics — same behavior, applies to non-streaming completions.
       */
      messages?: ChatMessage[];
      validation?: ValidationRetryConfig;
      signal?: AbortSignal;
      costContext?: AICostContext;
      seed?: number;
    }): Promise<AIGenerateResult> {
      return _generateCore(params);
    },

    async *streamGenerate(params: {
      prompt: string;
      input: Record<string, unknown>;
      /**
       * Optional native multi-turn conversation history. When supplied, the
       * provider receives `[system?, ...messages]` instead of a single user
       * message built from the rendered prompt. The rendered description
       * (`buildBasePrompt`) is merged into `system` so per-turn context is
       * not lost. Callers should ensure the LAST entry in `messages` is a
       * `user` turn (the latest input).
       */
      messages?: ChatMessage[];
      signal?: AbortSignal;
      costContext?: AICostContext;
      /**
       * Deterministic sampling seed forwarded to providers that support it
       * (OpenAI-compatible, including xAI/Grok). Combined with temperature 0
       * in the prompt definition, produces reproducible output. Silently
       * ignored by providers that do not support seeding.
       */
      seed?: number;
    }): AsyncIterable<AIStreamEvent> {
      const streamStart = performance.now();
      const { inputForAI, securityResult } = applyPromptSecurity(params.input);
      const streamSecurityWarnings = securityResult?.warnings.map((w) => w.message);

      // Budget pre-check
      checkBudget();

      // Build prompt
      const hasPromptDef = promptRegistry?.has(params.prompt);
      const promptInfo = hasPromptDef
        ? buildPromptText(params.prompt, inputForAI)
        : { text: params.prompt, substitutedKeys: new Set<string>() };

      // Resolve provider
      const activeProvider = resolveProvider(
        'provider' in promptInfo ? promptInfo.provider : undefined,
      );

      // Detect if the output schema is a simple single-string-field object
      // (e.g. z.object({ question: z.string() })). If so, stream plain text
      // so the user sees readable words instead of JSON tokens.
      const promptDef = hasPromptDef ? promptRegistry?.get(params.prompt) : undefined;
      const singleTextField = promptDef ? getSingleTextFieldName(promptDef.output) : undefined;
      const responseSchema = getStrictResponseSchema(params.prompt, promptDef);

      const basePrompt = buildBasePrompt(promptInfo, inputForAI);

      // The text-mode brevity hint is the right default for Q&A-style prompts
      // (it stops the model from accidentally wrapping a one-line answer in
      // JSON), but some models read "ONLY the plain text content" as a
      // brevity instruction and collapse long-form outputs into bullet
      // points. Prompts can opt out via `disableTextModeBrevityHint: true`
      // when they own their own length contract in the prompt body.
      const skipTextBrevityHint = promptDef?.disableTextModeBrevityHint === true;

      const useMultiTurn = Boolean(params.messages && params.messages.length > 0);
      const promptForProvider = useMultiTurn
        ? ''
        : singleTextField
          ? skipTextBrevityHint
            ? basePrompt
            : `${basePrompt}\n\nRespond with ONLY the plain text content. Do NOT wrap your response in JSON or any other format.`
          : !responseSchema && !basePrompt.toLowerCase().includes('json')
            ? `${basePrompt}\n\nRespond with a valid JSON object.`
            : basePrompt;

      const mergedSystem = useMultiTurn
        ? [promptInfo.system, basePrompt]
            .filter((s) => s && String(s).trim().length > 0)
            .join('\n\n')
        : promptInfo.system;

      const request: ProviderRequest = {
        system: mergedSystem || undefined,
        prompt: promptForProvider,
        // Native multi-turn: when caller supplies a messages array, providers
        // use it verbatim and ignore `prompt`. Otherwise legacy single-user
        // mode applies.
        messages: params.messages,
        model: promptInfo.model ?? config.defaultModel,
        temperature: promptInfo.temperature,
        maxTokens: promptInfo.maxTokens,
        responseFormat: singleTextField ? 'text' : 'json',
        responseSchema,
        structuredOutputTransport: promptDef?.structuredOutputTransport,
        signal: params.signal,
        seed: params.seed,
      };

      const resolvedModel = promptInfo.model ?? config.defaultModel ?? activeProvider.name;

      // Stream from provider, collecting full text and usage
      let fullText = '';
      let streamUsage: import('../types/context.js').AITokenUsage | undefined;
      let providerFinishReason: string | undefined;
      try {
        for await (const event of activeProvider.stream(request)) {
          if (event.type === 'content_delta' && event.delta) {
            fullText += event.delta;
            yield { type: 'delta', text: event.delta };
          } else if (event.type === 'usage' && event.usage) {
            streamUsage = {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              totalTokens: event.usage.totalTokens,
              cachedInputTokens: event.usage.cachedInputTokens,
              cacheWriteTokens: event.usage.cacheWriteTokens,
            };
          } else if (event.type === 'done') {
            // Capture the provider's finish_reason so downstream callers can
            // distinguish natural completion ('stop') from truncation
            // ('length') — essential when diagnosing short-output compression
            // vs a hit max_tokens ceiling.
            if (event.finishReason) {
              providerFinishReason = event.finishReason;
            }
          } else if (event.type === 'error') {
            // Provider-reported mid-stream error — record whatever usage we
            // have so the sunk spend is visible, then yield error to caller.
            const errCost = streamUsage
              ? calculateModelCost(
                  streamUsage.inputTokens,
                  streamUsage.outputTokens,
                  resolvedModel,
                  {
                    cachedInputTokens: streamUsage.cachedInputTokens,
                    cacheWriteTokens: streamUsage.cacheWriteTokens,
                  },
                )
              : null;
            await recordProviderCost(
              {
                model: resolvedModel,
                provider: activeProvider.name,
                promptName: hasPromptDef ? params.prompt : undefined,
                operation: 'generate',
                usage: streamUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                cost: errCost,
                latencyMs: 0,
                tenantId: config.budget?.tenantId,
                actor: config.budget?.actor,
                status: 'failed',
                errorMessage: event.error,
              },
              params.costContext,
            );
            yield { type: 'error', error: event.error };
            return;
          }
        }
      } catch (err) {
        // Transport-level failure mid-stream (fetch error, abort, etc.).
        const errUsage = getTypedAIErrorUsage(err) ??
          streamUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        const errCost =
          errUsage.totalTokens > 0
            ? calculateModelCost(errUsage.inputTokens, errUsage.outputTokens, resolvedModel, {
                cachedInputTokens: errUsage.cachedInputTokens,
                cacheWriteTokens: errUsage.cacheWriteTokens,
              })
            : null;
        await recordProviderCost(
          {
            model: resolvedModel,
            provider: activeProvider.name,
            promptName: hasPromptDef ? params.prompt : undefined,
            operation: 'generate',
            usage: errUsage,
            cost: errCost,
            latencyMs: 0,
            tenantId: config.budget?.tenantId,
            actor: config.budget?.actor,
            status: getTypedAIErrorStatus(err),
            errorMessage: err instanceof Error ? err.message : String(err),
          },
          params.costContext,
        );
        throw err;
      }

      // Compute cost and model info for the done event
      const streamCost = streamUsage
        ? calculateModelCost(streamUsage.inputTokens, streamUsage.outputTokens, resolvedModel, {
            cachedInputTokens: streamUsage.cachedInputTokens,
            cacheWriteTokens: streamUsage.cacheWriteTokens,
          })
        : 0;

      const doneBase = {
        usage: streamUsage,
        model: resolvedModel,
        provider: activeProvider.name,
        cost: streamCost,
        finishReason: providerFinishReason,
      };

      if (
        request.responseSchema &&
        (providerFinishReason === 'length' || providerFinishReason === 'max_tokens')
      ) {
        const failureUsage = streamUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        await recordProviderCost(
          {
            model: resolvedModel,
            provider: activeProvider.name,
            promptName: hasPromptDef ? params.prompt : undefined,
            operation: 'generate',
            usage: failureUsage,
            cost: null,
            latencyMs: 0,
            tenantId: config.budget?.tenantId,
            actor: config.budget?.actor,
            status: 'incomplete',
            errorMessage: `stream stopped before completing structured output: ${providerFinishReason}`,
          },
          params.costContext,
        );
        throw new AIIncompleteOutputError({
          provider: activeProvider.name,
          model: resolvedModel,
          partialText: fullText,
          usage: failureUsage,
          finishReason: providerFinishReason,
        });
      }

      // Build the final validated result
      if (singleTextField) {
        // Plain text mode — wrap the accumulated text in the schema field
        await recordProviderCost(
          {
            model: resolvedModel,
            provider: activeProvider.name,
            promptName: hasPromptDef ? params.prompt : undefined,
            operation: 'generate',
            usage: streamUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            cost: null,
            latencyMs: performance.now() - streamStart,
            tenantId: config.budget?.tenantId,
            actor: config.budget?.actor,
            status: 'success',
          },
          params.costContext,
        );
        if (explainability && streamSecurityWarnings?.length) {
          explainability.record({
            operation: 'generate',
            promptName: hasPromptDef ? params.prompt : undefined,
            model: resolvedModel,
            provider: activeProvider.name,
            input: params.input,
            output: { [singleTextField]: fullText.trim() },
            usage: streamUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            validation: { passed: true, attempts: 1 },
            securityWarnings: streamSecurityWarnings,
            actor: config.budget?.actor,
            tenantId: config.budget?.tenantId,
            latencyMs: performance.now() - streamStart,
          });
        }
        yield { type: 'done', data: { [singleTextField]: fullText.trim() }, ...doneBase };
      } else if (promptDef) {
        let validatedData: unknown;
        let validationFellBackToNonStreaming = false;
        let fallbackUsage: TokenUsage | undefined;
        try {
          const parsed = JSON.parse(fullText);
          validatedData = promptDef.output.parse(parsed);
        } catch (parseErr) {
          // Streamed output failed local validation. The default behaviour
          // is to fall back to a non-streaming JSON-mode retry — but that
          // silently doubles the input-token cost of large prompts. Prompts
          // that opt out via `skipStreamValidationFallback` get a hard
          // failure instead, so callers can implement their own recovery.
          if (promptDef.skipStreamValidationFallback) {
            const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            console.error(
              `[stream:${params.prompt}] validation-fallback SKIPPED by prompt config — stream produced invalid JSON (${errMsg}); throwing. streamedChars=${fullText.length} finishReason=${providerFinishReason ?? 'unknown'}`,
            );
            const failureUsage = streamUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
            const failureCost =
              failureUsage.totalTokens > 0
                ? calculateModelCost(
                    failureUsage.inputTokens,
                    failureUsage.outputTokens,
                    resolvedModel,
                    {
                      cachedInputTokens: failureUsage.cachedInputTokens,
                      cacheWriteTokens: failureUsage.cacheWriteTokens,
                    },
                  )
                : null;
            await recordProviderCost(
              {
                model: resolvedModel,
                provider: activeProvider.name,
                promptName: hasPromptDef ? params.prompt : undefined,
                operation: 'generate',
                usage: failureUsage,
                cost: failureCost,
                latencyMs: 0,
                tenantId: config.budget?.tenantId,
                actor: config.budget?.actor,
                status: 'failed',
                errorMessage: `stream-validation failed and fallback disabled: ${errMsg}`,
              },
              params.costContext,
            );
            throw new Error(
              `${params.prompt}: streaming JSON validation failed and fallback is disabled — ${errMsg}`,
            );
          }
          // Default path: fall back to a non-streaming JSON-mode retry with
          // full validation+feedback. Hidden cost doubler — log loudly and
          // tag the cost-ledger row so billing can surface how often it
          // fires.
          validationFellBackToNonStreaming = true;
          console.warn(
            `[stream:${params.prompt}] validation-fallback fired — stream produced invalid JSON (${parseErr instanceof Error ? parseErr.message : String(parseErr)}); replaying non-streaming. streamedChars=${fullText.length} finishReason=${providerFinishReason ?? 'unknown'}`,
          );
          try {
            const validated = await generateWithValidation(
              activeProvider,
              { ...request, responseFormat: 'json' },
              promptDef.output,
              { ...config.validation, model: resolvedModel, provider: activeProvider.name },
            );
            validatedData = validated.data;
            fallbackUsage = validated.usage;
          } catch (fallbackErr) {
            // Bill the caller for the combined streamUsage + whatever the
            // fallback provider ate before giving up (AIValidationError
            // carries the accumulated retry usage since A1).
            const fallbackErrorUsage =
              fallbackErr instanceof AIValidationError
                ? fallbackErr.usage
                : (getTypedAIErrorUsage(fallbackErr) ?? {
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                  });
            const combinedUsage = sumUsage(streamUsage, fallbackErrorUsage);
            const combinedCost =
              combinedUsage.totalTokens > 0
                ? calculateModelCost(
                    combinedUsage.inputTokens,
                    combinedUsage.outputTokens,
                    resolvedModel,
                    {
                      cachedInputTokens: combinedUsage.cachedInputTokens,
                      cacheWriteTokens: combinedUsage.cacheWriteTokens,
                    },
                  )
                : null;
            await recordProviderCost(
              {
                model: resolvedModel,
                provider: activeProvider.name,
                promptName: hasPromptDef ? params.prompt : undefined,
                operation: 'generate',
                usage: combinedUsage,
                cost: combinedCost,
                latencyMs: 0,
                tenantId: config.budget?.tenantId,
                actor: config.budget?.actor,
                status: getTypedAIErrorStatus(fallbackErr),
                errorMessage:
                  fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
              },
              params.costContext,
            );
            throw fallbackErr;
          }
        }
        const successUsage = validationFellBackToNonStreaming
          ? sumUsage(streamUsage, fallbackUsage)
          : (streamUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
        await recordProviderCost(
          {
            model: resolvedModel,
            provider: activeProvider.name,
            promptName: hasPromptDef ? params.prompt : undefined,
            operation: 'generate',
            fallbackUsed: validationFellBackToNonStreaming || undefined,
            usage: successUsage,
            cost: null,
            latencyMs: 0,
            tenantId: config.budget?.tenantId,
            actor: config.budget?.actor,
            status: 'success',
          },
          params.costContext,
        );
        yield {
          type: 'done',
          data: validatedData as Record<string, any>,
          ...doneBase,
          validationFallbackFired: validationFellBackToNonStreaming,
        };
      } else {
        await recordProviderCost(
          {
            model: resolvedModel,
            provider: activeProvider.name,
            promptName: hasPromptDef ? params.prompt : undefined,
            operation: 'generate',
            usage: streamUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            cost: null,
            latencyMs: 0,
            tenantId: config.budget?.tenantId,
            actor: config.budget?.actor,
            status: 'success',
          },
          params.costContext,
        );
        yield { type: 'done', data: { content: fullText }, ...doneBase };
      }
    },

    async extract(params: {
      schema: z.ZodTypeAny;
      text: string;
      signal?: AbortSignal;
      costContext?: AICostContext;
    }): Promise<Record<string, any>> {
      const start = performance.now();

      checkBudget();

      // extract uses default provider (no prompt-level routing)
      const activeProvider = resolveProvider();
      const resolvedModel = config.defaultModel ?? activeProvider.name;

      const systemPrompt =
        'Extract structured data from the following text. Return valid JSON matching the required schema.';
      const request: ProviderRequest = {
        system: systemPrompt,
        prompt: params.text,
        model: config.defaultModel,
        responseFormat: 'json',
        responseSchema: config.enableStrictStructuredOutputs
          ? zodToProviderJsonSchema(params.schema, { promptName: 'extract' }).schema
          : undefined,
        signal: params.signal,
      };

      let validated: import('./validation.js').ValidatedResponse<Record<string, any>>;
      try {
        validated = (await generateWithValidation(activeProvider, request, params.schema, {
          ...config.validation,
          model: resolvedModel,
          provider: activeProvider.name,
        })) as import('./validation.js').ValidatedResponse<Record<string, any>>;
      } catch (err) {
        const latencyMs = performance.now() - start;
        const failureUsage: TokenUsage =
          err instanceof AIValidationError
            ? err.usage
            : (getTypedAIErrorUsage(err) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
        await recordProviderCost(
          {
            model: resolvedModel,
            provider: activeProvider.name,
            operation: 'extract',
            usage: failureUsage,
            cost: null,
            latencyMs,
            tenantId: config.budget?.tenantId,
            actor: config.budget?.actor,
            status: getTypedAIErrorStatus(err),
            errorMessage: err instanceof Error ? err.message : String(err),
          },
          params.costContext,
        );
        throw err;
      }

      const latencyMs = performance.now() - start;

      await recordProviderCost(
        {
          model: resolvedModel,
          provider: activeProvider.name,
          operation: 'extract',
          usage: validated.usage,
          cost: null,
          latencyMs,
          tenantId: config.budget?.tenantId,
          actor: config.budget?.actor,
          status: 'success',
        },
        params.costContext,
      );

      if (explainability) {
        explainability.record({
          operation: 'extract',
          model: config.defaultModel,
          provider: activeProvider.name,
          input: { text: params.text },
          output: validated.data,
          usage: validated.usage,
          validation: { passed: validated.attempts === 1, attempts: validated.attempts },
          actor: config.budget?.actor,
          tenantId: config.budget?.tenantId,
          latencyMs,
        });
      }

      return validated.data;
    },

    async classify(params: {
      labels: string[];
      text: string;
      signal?: AbortSignal;
      costContext?: AICostContext;
    }): Promise<string[]> {
      const start = performance.now();

      checkBudget();

      // classify uses default provider (no prompt-level routing)
      const activeProvider = resolveProvider();
      const resolvedModel = config.defaultModel ?? activeProvider.name;

      const systemPrompt =
        'Classify the following text into one or more of the provided labels. Return a JSON array of matching label strings.';
      const request: ProviderRequest = {
        system: systemPrompt,
        prompt: `Labels: ${JSON.stringify(params.labels)}\n\nText: ${params.text}`,
        model: config.defaultModel,
        responseFormat: 'json',
        responseSchema: config.enableStrictStructuredOutputs
          ? zodToProviderJsonSchema(z.array(z.string()), { promptName: 'classify' }).schema
          : undefined,
        signal: params.signal,
      };

      const schema = z.array(z.string());
      let validated: Awaited<ReturnType<typeof generateWithValidation<string[]>>>;
      try {
        validated = await generateWithValidation(activeProvider, request, schema, {
          ...config.validation,
          model: resolvedModel,
          provider: activeProvider.name,
        });
      } catch (err) {
        const latencyMs = performance.now() - start;
        const failureUsage: TokenUsage =
          err instanceof AIValidationError
            ? err.usage
            : (getTypedAIErrorUsage(err) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
        await recordProviderCost(
          {
            model: resolvedModel,
            provider: activeProvider.name,
            operation: 'classify',
            usage: failureUsage,
            cost: null,
            latencyMs,
            tenantId: config.budget?.tenantId,
            actor: config.budget?.actor,
            status: getTypedAIErrorStatus(err),
            errorMessage: err instanceof Error ? err.message : String(err),
          },
          params.costContext,
        );
        throw err;
      }

      const latencyMs = performance.now() - start;

      // Filter to only valid labels
      const result = validated.data.filter((l: string) => params.labels.includes(l));

      await recordProviderCost(
        {
          model: resolvedModel,
          provider: activeProvider.name,
          operation: 'classify',
          usage: validated.usage,
          cost: null,
          latencyMs,
          tenantId: config.budget?.tenantId,
          actor: config.budget?.actor,
          status: 'success',
        },
        params.costContext,
      );

      if (explainability) {
        explainability.record({
          operation: 'classify',
          model: config.defaultModel,
          provider: activeProvider.name,
          input: { labels: params.labels, text: params.text },
          output: result,
          usage: validated.usage,
          validation: { passed: validated.attempts === 1, attempts: validated.attempts },
          actor: config.budget?.actor,
          tenantId: config.budget?.tenantId,
          latencyMs,
        });
      }

      return result;
    },

    async retrieve(params: {
      query: string;
      corpus?: string;
      filter?: Record<string, unknown>;
      limit?: number;
      minScore?: number;
      signal?: AbortSignal;
    }): Promise<AIDocument[]> {
      if (!ragPipeline) {
        throw new Error('RAG pipeline not configured — cannot perform retrieval');
      }

      const start = performance.now();

      checkBudget();

      const results = await ragPipeline.retrieve({
        query: params.query,
        tenantId: config.budget?.tenantId,
        corpus: params.corpus,
        filter: params.filter,
        limit: params.limit,
        minScore: params.minScore,
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
