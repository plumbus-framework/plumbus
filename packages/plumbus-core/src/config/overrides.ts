import { retryPolicySchema } from './retry.js';
import { z } from 'zod';
import { DataValidationError } from '../errors/index.js';
import type { PlumbusConfig } from '../types/config.js';

export type ConfigOverrides = {
  [K in keyof PlumbusConfig]?: NonNullable<PlumbusConfig[K]> extends object
    ? Partial<NonNullable<PlumbusConfig[K]>>
    : PlumbusConfig[K];
};
const text = z.string();
const positive = z.number().finite().positive();
const port = positive.int().max(65535);
/**
 * Whole milliseconds Node's timers accept. Matches the environment loader's
 * `AI_*REQUEST_TIMEOUT` and `PROMPT_*_TIMEOUT_MS` rules, so a value refused
 * from env at boot is also refused from `config/app.config.*`.
 */
const timeoutMs = positive.int().max(2_147_483_647);
const ai = z
  .object({
    provider: text,
    apiKey: text,
    model: text,
    baseUrl: text,
    maxTokensPerRequest: z.number().int().nonnegative(),
    dailyCostLimit: z.number().nonnegative(),
    requestTimeout: timeoutMs,
    region: text,
    pricingFilePath: text,
    embeddingModel: text,
    pricingCacheTtlMs: z.number().int().nonnegative(),
    cache: z.union([
      z.boolean(),
      z
        .object({
          system: z.boolean().optional(),
          tools: z.boolean().optional(),
          messages: z.boolean().optional(),
          key: z.string().optional(),
          ttl: z.enum(['30m', '12h']).optional(),
        })
        .strict(),
    ]),
  })
  .partial()
  .strict();
export const configOverridesSchema = z
  .object({
    environment: z.enum(['development', 'staging', 'production']),
    database: z
      .object({
        host: text.min(1),
        port,
        database: text,
        user: text,
        password: text,
        ssl: z.boolean(),
        poolSize: positive.int(),
      })
      .partial()
      .strict(),
    queue: z
      .object({
        host: text.min(1),
        port,
        password: text,
        prefix: text.min(1),
        url: text.url(),
        backend: z.enum(['memory', 'redis']),
        visibilityTimeoutSec: positive,
        pollIntervalMs: positive,
        reclaimIntervalMs: positive,
        startupTimeoutMs: positive,
        operationTimeoutMs: positive,
        shutdownTimeoutMs: positive,
      })
      .partial()
      .strict(),
    auth: z
      .object({ provider: text, issuer: text, audience: text, jwksUri: text, secret: text })
      .partial()
      .strict(),
    execution: z.object({ transactionalOutbox: z.boolean() }).partial().strict(),
    ai,
    aiProviders: z
      .object({
        defaultProvider: text,
        defaultModel: text,
        providers: z.record(ai),
        promptOverrides: z.record(
          z
            .object({
              provider: text,
              model: text,
              temperature: z.number().min(0).max(2),
              maxTokens: positive.int(),
              timeoutMs,
              reasoning: z.unknown(),
              reasoningEffort: text,
            })
            .partial()
            .strict(),
        ),
        security: z.record(z.unknown()),
        cache: ai.shape.cache,
      })
      .partial()
      .strict(),
    mcp: z
      .object({
        agents: z
          .record(
            z
              .object({ serviceAccountId: text, scopes: z.array(text), tenantId: text.optional() })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    workers: z
      .object({
        enableScheduler: z.boolean().optional(),
        eventDelivery: z
          .object({
            retry: retryPolicySchema.optional(),
            unrouted: z.enum(['deadLetter', 'acknowledge']).optional(),
            ignoredEventTypes: z.array(text).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    complianceProfiles: z.array(text),
  })
  .partial()
  .strict();

export function parseConfigOverrides(input: unknown): ConfigOverrides {
  const parsed = configOverridesSchema.safeParse(input);
  if (!parsed.success) {
    // Values can be secrets. Only report paths and issue codes.
    throw new DataValidationError('Invalid configuration overrides', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        ...(issue.code === 'unrecognized_keys' ? { keys: issue.keys } : {}),
      })),
    });
  }
  return parsed.data as ConfigOverrides;
}

export function mergeConfig<T extends object>(base: T, override: object): T {
  const result: Record<string, unknown> = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new DataValidationError('Unsafe configuration key');
    if (value === undefined) continue;
    const record = z.record(z.unknown()).safeParse(value);
    const previous = z.record(z.unknown()).safeParse(result[key]);
    result[key] =
      record.success && previous.success ? mergeConfig(previous.data, record.data) : value;
  }
  return result as T;
}
