import { z } from '@plumbus/core/zod';
import { deepFreeze } from '../internal/deep-freeze.js';
import { throwDefineValidationError } from '../internal/validation-error.js';
import { warnMissingChatPromptBaseFields } from './chat-prompt-base-fields.js';
import type { ChatConfig, ChatDefinition } from '../types/chat.js';

const chatConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  access: z.record(z.unknown()),
  context: z.array(z.custom()).optional(),
  actions: z.array(z.string()).optional(),
  policy: z
    .object({
      audience: z
        .object({
          roles: z.array(z.string()).min(1),
          default: z.string().optional(),
          mode: z.enum(['strict', 'permissive']).optional(),
        })
        .optional(),
      scope: z
        .object({
          description: z.string().optional(),
          classifier: z.enum(['inline', 'custom']).optional(),
          locales: z.array(z.string()).optional(),
        })
        .optional(),
      reply: z.object({ locale: z.union([z.literal('auto'), z.string()]).optional() }).optional(),
      privacy: z.object({ redact: z.array(z.string()).optional() }).optional(),
      provenance: z
        .object({
          required: z.boolean().optional(),
          minSources: z.number().int().min(0).optional(),
        })
        .optional(),
      behavioral: z
        .object({
          cooldowns: z.array(
            z.object({
              trigger: z.enum(['refusal', 'guardFailure', 'budget']),
              count: z.number().int().min(1),
              windowSeconds: z.number().int().min(0).optional(),
              durationSeconds: z.number().int().min(1),
              scope: z.enum(['session', 'user']).optional(),
            }),
          ),
        })
        .optional(),
      action: z
        .object({
          allowedCapabilities: z.array(z.string()).optional(),
          frameworkExecuteOnConfirm: z.boolean().optional(),
        })
        .optional(),
      toolCalling: z
        .object({
          enabled: z.boolean(),
          capabilities: z.array(z.string()).optional(),
          autoStartFlows: z.array(z.string()).optional(),
          maxToolRounds: z.number().int().min(1).max(20).optional(),
          maxTools: z.number().int().min(1).max(64).optional(),
          flowAwaitMs: z.number().int().min(0).max(120_000).optional(),
          flowPollIntervalMs: z.number().int().min(50).max(10_000).optional(),
          flowAwaitBudgetMsPerTurn: z.number().int().min(0).max(120_000).optional(),
          maxFlowStartsPerTurn: z.number().int().min(0).max(20).optional(),
          confirmationTtlMs: z.number().int().min(60_000).max(3_600_000).optional(),
        })
        .optional(),
    })
    .optional(),
  budget: z.record(z.unknown()).optional(),
  history: z
    .object({
      includeLastTurns: z.number().int().min(1).optional(),
      summarize: z
        .object({
          strategy: z.enum(['rolling', 'threshold']),
          thresholdTurns: z.number().int().optional(),
          targetTokens: z.number().int().optional(),
        })
        .optional(),
    })
    .optional(),
  instructions: z.array(z.string()).optional(),
  prompt: z.custom().optional(),
  persistence: z
    .object({
      messageContent: z.enum(['server', 'client']),
      saveToDb: z.boolean().optional(),
    })
    .optional(),
  exposeAs: z.enum(['capability', 'sse', 'both']).optional(),
  streaming: z.boolean().optional(),
});

let warnedEmptyContext = false;

export function defineChat(config: ChatConfig): ChatDefinition {
  const parsed = chatConfigSchema.safeParse(config);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throwDefineValidationError(`defineChat: ${detail}`);
  }

  if (!config.context || config.context.length === 0) {
    if (!warnedEmptyContext) {
      warnedEmptyContext = true;
      console.warn(
        '[@plumbus/chat] defineChat: context is empty — chat has no grounding sources (valid but uncommon).',
      );
    }
  }

  if (config.prompt) {
    warnMissingChatPromptBaseFields(config.prompt);
  }

  const audience = config.policy?.audience;
  if (audience && (audience.mode ?? 'strict') === 'strict' && audience.roles.length === 0) {
    throwDefineValidationError('defineChat: audience.roles must not be empty in strict mode');
  }

  const saveToDb = config.persistence?.saveToDb ?? true;
  if (!saveToDb && config.persistence?.messageContent === 'server') {
    throwDefineValidationError(
      "defineChat: persistence.saveToDb=false requires persistence.messageContent='client' — there is no chat_turn row to hold server-side content",
    );
  }
  const legacyAllowlist = config.policy?.action?.allowedCapabilities ?? config.actions ?? [];
  const toolCallingEnabled = config.policy?.toolCalling?.enabled === true;
  if (!saveToDb && legacyAllowlist.length > 0) {
    throwDefineValidationError(
      'defineChat: persistence.saveToDb=false cannot coexist with an action allowlist (actions / policy.action.allowedCapabilities) — pending actions require chat_pending_action rows to survive across requests',
    );
  }
  if (!saveToDb && toolCallingEnabled) {
    throwDefineValidationError(
      'defineChat: persistence.saveToDb=false cannot coexist with policy.toolCalling.enabled — tool execution records require chat_turn rows',
    );
  }
  if (toolCallingEnabled && legacyAllowlist.length > 0) {
    throwDefineValidationError(
      'defineChat: policy.toolCalling.enabled cannot be combined with the legacy action allowlist (actions / policy.action.allowedCapabilities) — choose one action path',
    );
  }

  // Fold the legacy top-level `actions` list into `policy.action.allowedCapabilities`
  // (Path A allowlist) so the runtime reads a single source. `policy.action`
  // takes precedence when both are set.
  const legacyActions = config.actions ?? [];
  const normalizedPolicy =
    config.policy || legacyActions.length > 0
      ? {
          ...config.policy,
          ...(legacyActions.length > 0 && !config.policy?.action?.allowedCapabilities
            ? { action: { ...config.policy?.action, allowedCapabilities: legacyActions } }
            : {}),
        }
      : undefined;

  return deepFreeze({
    ...config,
    ...(normalizedPolicy ? { policy: normalizedPolicy } : {}),
    context: config.context ?? [],
    persistence: {
      messageContent: config.persistence?.messageContent ?? 'server',
      saveToDb,
    },
    exposeAs: config.exposeAs ?? 'sse',
    streaming: config.streaming ?? true,
    kind: 'chat' as const,
  });
}
