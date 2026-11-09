import {
  recordVoiceCost,
  resolveTtsCostModelKey,
  lookupVoicePricing,
  calculateVoiceCost,
} from '../cost/index.js';
import {
  evaluateAccess,
  ErrorCode,
  PlumbusError,
  type RouteGeneratorConfig,
} from '@plumbus/core/sdk';
import { createExecutionContext } from '@plumbus/core/runtime';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  assertCloneSampleWithinLimit,
  createVoiceCloneProvider,
  synthesizeWithVoiceReference,
} from '../providers/create-voice-clone-provider.js';
import { createProviderRegistry, type VoiceProviderRegistry } from '../providers/registry.js';
import type { ClonedVoice } from '../types/clone.js';
import type { RegisterVoiceCloneRoutesOpts, VoiceCloneAuth } from '../types/http.js';
import {
  assertValidExternalBaseUrl,
  assertVoiceBrowserSecurity,
  guardVoiceBrowserRequest,
  resolveVoiceRequestCredential,
} from '../security/browser-guard.js';

/**
 * Ownership-aware HTTP surface for persisted voice clones + optional instant-reference preview.
 * Requires `@fastify/multipart` when handling create / synthesize-reference uploads.
 */
export function registerVoiceCloneRoutes(
  app: FastifyInstance,
  routeConfig: RouteGeneratorConfig,
  opts: RegisterVoiceCloneRoutesOpts,
): void {
  assertValidExternalBaseUrl(opts.externalBaseUrl);
  assertVoiceBrowserSecurity('registerVoiceCloneRoutes', opts);
  let cachedRegistry: VoiceProviderRegistry | undefined = opts.registry;
  const resolveRegistry = async (): Promise<VoiceProviderRegistry> => {
    if (opts.resolveRegistry) {
      return opts.resolveRegistry();
    }
    if (cachedRegistry) {
      return cachedRegistry;
    }
    cachedRegistry = createProviderRegistry();
    return cachedRegistry;
  };
  const cookieNames = opts.authCookieNames ?? [];

  app.post('/api/voice/providers/:providerId/clones', async (req, reply) => {
    const authResult = await authenticateCloneRequest(
      req,
      reply,
      routeConfig,
      cookieNames,
      opts.access,
      opts,
    );
    if (!authResult.ok) {
      return reply.status(authResult.status).send(authResult.body);
    }
    const { auth } = authResult;
    const providerId = readProviderId(req);
    const registry = await resolveRegistry();
    const clone = createVoiceCloneProvider({
      providerId,
      providers: opts.providers,
      registry,
    });

    let upload: MultipartAudioResult;
    try {
      upload = await readMultipartAudio(
        req,
        'file',
        cloneSampleLimit(clone.capabilities.maxSampleBytes, opts.maxSampleBytes),
      );
    } catch (error) {
      if (isSampleTooLarge(error)) {
        return reply
          .status(400)
          .send({ error: 'voice.clone.sample_too_large', message: error.message });
      }
      throw error;
    }
    const fields = upload.fields;
    const name = readRequiredString(fields, 'name');
    const gender = readOptionalGender(fields);
    const locale = readOptionalString(fields, 'locale');
    const model = readOptionalString(fields, 'model');
    const speakingStyle = readOptionalString(fields, 'speakingStyle');
    const age = readOptionalNumber(fields, 'age');

    if (clone.capabilities.requiresGender && !gender) {
      return reply.status(400).send({ error: 'voice.clone.gender_required' });
    }
    if (clone.capabilities.requiresLocale && !locale) {
      return reply.status(400).send({ error: 'voice.clone.locale_required' });
    }

    try {
      assertCloneSampleWithinLimit(upload.audio, clone.capabilities, opts.maxSampleBytes);
    } catch (error) {
      if (error instanceof PlumbusError) {
        return reply
          .status(400)
          .send({ error: 'voice.clone.sample_too_large', message: error.message });
      }
      throw error;
    }

    let created: ClonedVoice;
    try {
      created = await clone.create({
        name,
        audio: upload.audio,
        filename: upload.filename,
        mimeType: upload.mimeType,
        ...(gender ? { gender } : {}),
        ...(locale ? { locale } : {}),
        ...(model ? { model } : {}),
        ...(speakingStyle ? { speakingStyle } : {}),
        ...(age !== undefined ? { age } : {}),
      });
    } catch (error) {
      return reply.status(mapVendorErrorStatus(error)).send(mapVendorErrorBody(error));
    }

    try {
      await opts.afterCloneCreate({ providerId, voice: created, auth });
    } catch (persistError) {
      try {
        await clone.delete(created.id);
      } catch {
        // best-effort rollback
      }
      console.error('[plumbus:voice] afterCloneCreate failed; vendor clone rolled back', {
        providerId,
        voiceId: created.id,
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
      return reply.status(500).send({
        error: 'voice.clone.persist_failed',
        message: 'Failed to persist clone ownership mapping',
      });
    }

    return reply.status(201).send({ voice: created });
  });

  app.get('/api/voice/providers/:providerId/clones', async (req, reply) => {
    const authResult = await authenticateCloneRequest(
      req,
      reply,
      routeConfig,
      cookieNames,
      opts.access,
      opts,
    );
    if (!authResult.ok) {
      return reply.status(authResult.status).send(authResult.body);
    }
    const providerId = readProviderId(req);
    const voices = await opts.listOwnedClones({ providerId, auth: authResult.auth });
    return reply.send({ voices });
  });

  app.get('/api/voice/providers/:providerId/clones/:id', async (req, reply) => {
    const authResult = await authenticateCloneRequest(
      req,
      reply,
      routeConfig,
      cookieNames,
      opts.access,
      opts,
    );
    if (!authResult.ok) {
      return reply.status(authResult.status).send(authResult.body);
    }
    const providerId = readProviderId(req);
    const voiceId = readPathParam(req, 'id');
    const ownerOk = await assertOwnsClone(opts, providerId, voiceId, authResult.auth);
    if (!ownerOk) {
      return reply
        .status(403)
        .send({ error: { code: 'forbidden', message: 'Clone ownership denied' } });
    }
    const clone = createVoiceCloneProvider({
      providerId,
      providers: opts.providers,
      registry: await resolveRegistry(),
    });
    const voice = await clone.get(voiceId);
    if (!voice) {
      return reply.status(404).send({ error: 'voice.clone.not_found' });
    }
    return reply.send({ voice });
  });

  app.delete('/api/voice/providers/:providerId/clones/:id', async (req, reply) => {
    const authResult = await authenticateCloneRequest(
      req,
      reply,
      routeConfig,
      cookieNames,
      opts.access,
      opts,
    );
    if (!authResult.ok) {
      return reply.status(authResult.status).send(authResult.body);
    }
    const providerId = readProviderId(req);
    const voiceId = readPathParam(req, 'id');
    const ownerOk = await assertOwnsClone(opts, providerId, voiceId, authResult.auth);
    if (!ownerOk) {
      return reply
        .status(403)
        .send({ error: { code: 'forbidden', message: 'Clone ownership denied' } });
    }
    const clone = createVoiceCloneProvider({
      providerId,
      providers: opts.providers,
      registry: await resolveRegistry(),
    });
    await clone.delete(voiceId);
    await opts.afterCloneDelete?.({ providerId, voiceId, auth: authResult.auth });
    return reply.status(204).send();
  });

  app.post('/api/voice/providers/:providerId/clones/:id/wait', async (req, reply) => {
    const authResult = await authenticateCloneRequest(
      req,
      reply,
      routeConfig,
      cookieNames,
      opts.access,
      opts,
    );
    if (!authResult.ok) {
      return reply.status(authResult.status).send(authResult.body);
    }
    const providerId = readProviderId(req);
    const voiceId = readPathParam(req, 'id');
    const ownerOk = await assertOwnsClone(opts, providerId, voiceId, authResult.auth);
    if (!ownerOk) {
      return reply
        .status(403)
        .send({ error: { code: 'forbidden', message: 'Clone ownership denied' } });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model = typeof body.model === 'string' ? body.model : undefined;
    const clone = createVoiceCloneProvider({
      providerId,
      providers: opts.providers,
      registry: await resolveRegistry(),
    });
    try {
      const voice = await clone.waitUntilReady(voiceId, model ? { model } : undefined);
      return reply.send({ voice });
    } catch (error) {
      return reply.status(mapVendorErrorStatus(error)).send(mapVendorErrorBody(error));
    }
  });

  app.post('/api/voice/providers/:providerId/clones/:id/recompute', async (req, reply) => {
    const authResult = await authenticateCloneRequest(
      req,
      reply,
      routeConfig,
      cookieNames,
      opts.access,
      opts,
    );
    if (!authResult.ok) {
      return reply.status(authResult.status).send(authResult.body);
    }
    const providerId = readProviderId(req);
    const voiceId = readPathParam(req, 'id');
    const ownerOk = await assertOwnsClone(opts, providerId, voiceId, authResult.auth);
    if (!ownerOk) {
      return reply
        .status(403)
        .send({ error: { code: 'forbidden', message: 'Clone ownership denied' } });
    }
    const clone = createVoiceCloneProvider({
      providerId,
      providers: opts.providers,
      registry: await resolveRegistry(),
    });
    if (!clone.recompute || !clone.capabilities.supportsRecompute) {
      return reply.status(501).send({ error: 'voice.clone.recompute_unsupported' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model = typeof body.model === 'string' ? body.model : undefined;
    try {
      const voice = await clone.recompute(voiceId, model ? { model } : undefined);
      return reply.send({ voice });
    } catch (error) {
      return reply.status(mapVendorErrorStatus(error)).send(mapVendorErrorBody(error));
    }
  });

  if (opts.referenceAccess) {
    const referenceAccess = opts.referenceAccess;
    app.post('/api/voice/providers/:providerId/synthesize-reference', async (req, reply) => {
      const authResult = await authenticateCloneRequest(
        req,
        reply,
        routeConfig,
        cookieNames,
        referenceAccess,
        opts,
      );
      if (!authResult.ok) {
        return reply.status(authResult.status).send(authResult.body);
      }
      const providerId = readProviderId(req);
      const registry = await resolveRegistry();
      const registration = registry.tts.get(providerId);
      if (!registration?.clone?.synthesizeWithVoiceReference) {
        // Fail before reading the upload: synthesis would reject this provider anyway.
        const unsupported = registration
          ? new PlumbusError(
              ErrorCode.Validation,
              `Voice tts provider "${providerId}" does not support instant voice-reference synthesis`,
              { providerId },
            )
          : new PlumbusError(
              ErrorCode.NotFound,
              `Voice tts provider "${providerId}" is not registered`,
              { providerId, kind: 'tts' },
            );
        return reply
          .status(mapVendorErrorStatus(unsupported))
          .send(mapVendorErrorBody(unsupported));
      }
      let upload: MultipartAudioResult;
      try {
        upload = await readMultipartAudio(
          req,
          'file',
          cloneSampleLimit(registration.clone.capabilities.maxSampleBytes, opts.maxSampleBytes),
        );
      } catch (error) {
        if (isSampleTooLarge(error)) {
          return reply
            .status(400)
            .send({ error: 'voice.clone.sample_too_large', message: error.message });
        }
        throw error;
      }
      const text = readRequiredString(upload.fields, 'text');
      const locale = readOptionalString(upload.fields, 'locale');
      const model = readOptionalString(upload.fields, 'model');
      const dependencies = routeConfig.createDependencies(authResult.auth);
      const costCtx = dependencies.ai ? createExecutionContext(dependencies) : undefined;
      const costModel =
        resolveTtsCostModelKey(
          { provider: providerId, model },
          registration?.descriptor.knownModels,
        ) ??
        model ??
        providerId;
      const mediaUsage = { characters: text.length };
      if (costCtx)
        costCtx.ai.checkProviderCostBudget({
          estimatedCostUsd: lookupVoicePricing(costModel)
            ? calculateVoiceCost(costModel, mediaUsage)
            : undefined,
        });
      const started = performance.now();
      let audio: Uint8Array;
      try {
        audio = await synthesizeWithVoiceReference({
          providerId,
          providers: opts.providers,
          registry,
          input: {
            text,
            audio: upload.audio,
            filename: upload.filename,
            ...(locale ? { locale } : {}),
            ...(model ? { model } : {}),
          },
        });
      } catch (error) {
        if (costCtx)
          await recordVoiceCost(costCtx, {
            operation: 'synthesize',
            provider: providerId,
            model: costModel,
            mediaUsage,
            latencyMs: performance.now() - started,
            status: 'failed',
            costContext: { serviceArea: 'voice', operationName: 'synthesize-reference' },
          });
        return reply.status(mapVendorErrorStatus(error)).send(mapVendorErrorBody(error));
      }
      if (costCtx)
        await recordVoiceCost(costCtx, {
          operation: 'synthesize',
          provider: providerId,
          model: costModel,
          mediaUsage,
          latencyMs: performance.now() - started,
          status: 'success',
          costContext: { serviceArea: 'voice', operationName: 'synthesize-reference' },
        });
      return reply.header('content-type', 'application/octet-stream').send(Buffer.from(audio));
    });
  }
}

async function assertOwnsClone(
  opts: RegisterVoiceCloneRoutesOpts,
  providerId: string,
  voiceId: string,
  auth: VoiceCloneAuth,
): Promise<boolean> {
  const ownerId = await opts.resolveCloneOwner({ providerId, voiceId, auth });
  const principalId = typeof auth.userId === 'string' ? auth.userId : undefined;
  return Boolean(ownerId && principalId && ownerId === principalId);
}

async function authenticateCloneRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  routeConfig: RouteGeneratorConfig,
  cookieNames: string[],
  access: RegisterVoiceCloneRoutesOpts['access'],
  opts: RegisterVoiceCloneRoutesOpts,
): Promise<{ ok: true; auth: VoiceCloneAuth } | { ok: false; status: number; body: unknown }> {
  const credential = resolveVoiceRequestCredential(req, cookieNames);
  const auth = await routeConfig.authAdapter.authenticate(credential.token);
  if (!auth) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }
  const browser = guardVoiceBrowserRequest(req, reply, auth, credential.source, opts, {
    mutation: req.method !== 'GET' && req.method !== 'HEAD',
  });
  if (!browser.ok) {
    return browser;
  }
  const authz = evaluateAccess(access, auth);
  if (!authz.allowed) {
    return {
      ok: false,
      status: 403,
      body: {
        error: { code: 'forbidden', message: authz.reason ?? 'Access denied' },
      },
    };
  }
  return { ok: true, auth };
}

function readProviderId(req: FastifyRequest): string {
  const params = req.params as { providerId?: string };
  if (!params.providerId) {
    throw new PlumbusError(ErrorCode.Validation, 'providerId path param is required');
  }
  return params.providerId;
}

function readPathParam(req: FastifyRequest, name: string): string {
  const params = req.params as Record<string, string | undefined>;
  const value = params[name];
  if (!value) {
    throw new PlumbusError(ErrorCode.Validation, `${name} path param is required`);
  }
  return value;
}

interface MultipartAudioResult {
  audio: Buffer;
  filename: string;
  mimeType?: string;
  fields: Record<string, string>;
}

type MultipartLimitsOptions = { limits: { fileSize: number } } | undefined;

/** Same limit `assertCloneSampleWithinLimit` applies: the smaller of provider cap and route override. */
function cloneSampleLimit(providerMax: number, routeOverride: number | undefined): number {
  return Math.min(routeOverride ?? Number.POSITIVE_INFINITY, providerMax);
}

const SAMPLE_TOO_LARGE = Symbol('voice.clone.sample_too_large');

function sampleTooLargeError(limit: number, byteLength: number): PlumbusError {
  const error = new PlumbusError(
    ErrorCode.Validation,
    `Voice clone sample exceeds maxSampleBytes (${limit})`,
    { byteLength, maxSampleBytes: limit },
  );
  (error as unknown as Record<symbol, boolean>)[SAMPLE_TOO_LARGE] = true;
  return error;
}

function isSampleTooLarge(error: unknown): error is PlumbusError {
  return (
    error instanceof PlumbusError &&
    (error as unknown as Record<symbol, boolean>)[SAMPLE_TOO_LARGE] === true
  );
}

/** `@fastify/multipart` raises this when its own `limits.fileSize` is exceeded. */
function isMultipartFileTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE'
  );
}

/**
 * Read a file stream chunk by chunk, aborting as soon as more than `limit` bytes
 * arrive. Leaving the `for await` early destroys the stream, so the rest of the
 * upload is never buffered.
 */
async function readBoundedStream(
  stream: AsyncIterable<Buffer | Uint8Array> & { truncated?: boolean },
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > limit) {
        throw sampleTooLargeError(limit, total);
      }
      chunks.push(buf);
    }
  } catch (error) {
    if (isMultipartFileTooLarge(error)) throw sampleTooLargeError(limit, total);
    throw error;
  }
  // A plugin configured not to throw on its size limit truncates silently instead.
  if (stream.truncated === true) throw sampleTooLargeError(limit, total);
  return Buffer.concat(chunks, total);
}

async function readMultipartAudio(
  req: FastifyRequest,
  fileField: string,
  maxBytes: number,
): Promise<MultipartAudioResult> {
  const request = req as FastifyRequest & {
    file?: (options?: MultipartLimitsOptions) => Promise<
      | {
          file: AsyncIterable<Buffer> & { truncated?: boolean };
          filename: string;
          mimetype: string;
          fields: Record<string, { value?: string } | undefined>;
        }
      | undefined
    >;
    parts?: (options?: MultipartLimitsOptions) => AsyncIterable<{
      type: string;
      fieldname: string;
      value?: string;
      filename?: string;
      mimetype?: string;
      toBuffer?: () => Promise<Buffer>;
      file?: AsyncIterable<Buffer> & { truncated?: boolean; resume?: () => void };
    }>;
  };
  // One byte over the cap, so the plugin stops the stream right after our own check fires.
  const limitsOptions: MultipartLimitsOptions = Number.isFinite(maxBytes)
    ? { limits: { fileSize: maxBytes + 1 } }
    : undefined;

  if (typeof request.file === 'function') {
    let file: Awaited<ReturnType<NonNullable<typeof request.file>>>;
    try {
      file = await request.file(limitsOptions);
    } catch (error) {
      if (isMultipartFileTooLarge(error)) throw sampleTooLargeError(maxBytes, maxBytes + 1);
      throw error;
    }
    if (!file) {
      throw new PlumbusError(ErrorCode.Validation, `Multipart field "${fileField}" is required`);
    }
    const audio = await readBoundedStream(file.file, maxBytes);
    const fields: Record<string, string> = {};
    for (const [key, entry] of Object.entries(file.fields ?? {})) {
      if (entry && typeof entry.value === 'string') {
        fields[key] = entry.value;
      }
    }
    return {
      audio,
      filename: file.filename || 'sample.wav',
      mimeType: file.mimetype,
      fields,
    };
  }

  if (typeof request.parts === 'function') {
    const fields: Record<string, string> = {};
    let audio: Buffer | undefined;
    let filename = 'sample.wav';
    let mimeType: string | undefined;
    try {
      for await (const part of request.parts(limitsOptions)) {
        if (part.type === 'file' && part.fieldname === fileField) {
          if (part.file) {
            audio = await readBoundedStream(part.file, maxBytes);
          } else if (typeof part.toBuffer === 'function') {
            // Non-streaming shims only; @fastify/multipart always provides part.file.
            audio = await part.toBuffer();
            if (audio.byteLength > maxBytes) throw sampleTooLargeError(maxBytes, audio.byteLength);
          }
          filename = part.filename || filename;
          mimeType = part.mimetype;
        } else if (part.type === 'file') {
          // Discard other files without buffering them.
          part.file?.resume?.();
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (error) {
      if (isMultipartFileTooLarge(error)) throw sampleTooLargeError(maxBytes, maxBytes + 1);
      throw error;
    }
    if (!audio) {
      throw new PlumbusError(ErrorCode.Validation, `Multipart field "${fileField}" is required`);
    }
    return { audio, filename, mimeType, fields };
  }

  throw new PlumbusError(
    ErrorCode.DependencyViolation,
    'Voice clone upload routes require @fastify/multipart — register it on the Fastify app before registerVoiceCloneRoutes()',
  );
}

function readRequiredString(fields: Record<string, string>, key: string): string {
  const value = fields[key];
  if (!value || value.length === 0) {
    throw new PlumbusError(ErrorCode.Validation, `Field "${key}" is required`);
  }
  return value;
}

function readOptionalString(fields: Record<string, string>, key: string): string | undefined {
  const value = fields[key];
  return value && value.length > 0 ? value : undefined;
}

function readOptionalNumber(fields: Record<string, string>, key: string): number | undefined {
  const raw = fields[key];
  if (raw === undefined || raw.length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readOptionalGender(fields: Record<string, string>): 'male' | 'female' | undefined {
  const value = fields.gender;
  if (value === 'male' || value === 'female') return value;
  return undefined;
}

function mapVendorErrorStatus(error: unknown): number {
  if (error instanceof PlumbusError) {
    if (error.code === ErrorCode.Validation) return 400;
    if (error.code === ErrorCode.NotFound) return 404;
    if (error.code === ErrorCode.DependencyViolation) return 400;
  }
  return 500;
}

const GENERIC_CLONE_ERROR_MESSAGES: Record<number, string> = {
  400: 'Voice clone request was rejected',
  404: 'Voice clone resource was not found',
  500: 'Voice clone provider request failed',
};

/** Client-safe body: keeps the error code, never vendor text or Plumbus metadata. */
function mapVendorErrorBody(error: unknown): unknown {
  const status = mapVendorErrorStatus(error);
  const code = error instanceof PlumbusError ? error.code : 'voice.clone.vendor_error';
  console.error('[plumbus:voice] voice clone request failed', {
    code,
    status,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof PlumbusError && error.metadata ? { metadata: error.metadata } : {}),
  });
  return {
    error: code,
    message: GENERIC_CLONE_ERROR_MESSAGES[status] ?? GENERIC_CLONE_ERROR_MESSAGES[500],
  };
}
