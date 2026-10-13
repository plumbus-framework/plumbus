import { ErrorCode, PlumbusError } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import type { VoiceProviderCredentials } from '../types/provider.js';
import type {
  FileTranscriptionConfig,
  FileTranscriptionContext,
  FileTranscriptionOperationOptions,
  FileTranscriptionProvider,
  FileTranscriptionProviderRegistration,
} from './types.js';

const configSchema = z
  .object({
    model: z.string().min(1).max(128),
    region: z.string().min(1).max(64),
    maxInputBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    maxTokens: z.number().int().positive().max(1000000).optional(),
    maxPages: z.number().int().positive().max(100).optional(),
    pageSize: z.number().int().positive().max(1000).optional(),
    timeoutMs: z.number().int().positive().max(300000).optional(),
    languageHints: z
      .array(z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/))
      .max(10)
      .optional(),
  })
  .strict();

/** Short provider operations for app-owned capabilities/flows; never creates a worker or job. */
export function createFileTranscriptionRuntime(input: {
  registration: FileTranscriptionProviderRegistration;
  credentials: VoiceProviderCredentials;
  config: FileTranscriptionConfig;
}) {
  const parsed = configSchema.safeParse(input.config);
  if (!parsed.success) {
    throw new PlumbusError(ErrorCode.Validation, 'Invalid file transcription configuration');
  }
  const config = parsed.data;
  const provider = input.registration.create(input.credentials, config);
  function operation<K extends keyof FileTranscriptionProvider>(name: K, paid = false) {
    return async (
      ctx: FileTranscriptionContext,
      args: Parameters<FileTranscriptionProvider[K]>[0],
      options: FileTranscriptionOperationOptions = {},
    ): Promise<Awaited<ReturnType<FileTranscriptionProvider[K]>>> => {
      const signals = [
        ctx.signal,
        options.signal,
        AbortSignal.timeout(config.timeoutMs ?? 30000),
      ].filter((signal): signal is AbortSignal => signal !== undefined);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      signal?.throwIfAborted();
      if (paid) {
        const estimate = z.number().finite().nonnegative().safeParse(options.estimatedCostUsd);
        if (!estimate.success) {
          throw new PlumbusError(
            ErrorCode.Validation,
            'File transcription requires known admission pricing',
          );
        }
        ctx.ai.checkProviderCostBudget({ estimatedCostUsd: estimate.data });
      }
      // Correlated method and argument are selected together; no dynamic app method dispatch.
      const call = provider[name] as (
        input: typeof args,
        options: FileTranscriptionOperationOptions,
      ) => ReturnType<FileTranscriptionProvider[K]>;
      return (await call.call(provider, args, { ...options, signal })) as Awaited<
        ReturnType<FileTranscriptionProvider[K]>
      >;
    };
  }
  return Object.freeze({
    upload: operation('upload', true),
    reconcileUpload: operation('reconcileUpload'),
    submit: operation('submit', true),
    reconcileSubmission: operation('reconcileSubmission'),
    getJob: operation('getJob'),
    getTranscript: operation('getTranscript'),
    getUsage: operation('getUsage'),
    deleteJob: operation('deleteJob'),
    deleteFile: operation('deleteFile'),
  });
}
