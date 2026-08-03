import { evaluateAccess, ErrorCode, PlumbusError, type RouteGeneratorConfig } from '@plumbus/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  assertCloneSampleWithinLimit,
  createVoiceCloneProvider,
  synthesizeWithVoiceReference,
} from '../providers/create-voice-clone-provider.js';
import { createProviderRegistry, type VoiceProviderRegistry } from '../providers/registry.js';
import type { ClonedVoice } from '../types/clone.js';
import type { RegisterVoiceCloneRoutesOpts, VoiceCloneAuth } from '../types/http.js';

/**
 * Ownership-aware HTTP surface for persisted voice clones + optional instant-reference preview.
 * Requires `@fastify/multipart` when handling create / synthesize-reference uploads.
 */
export function registerVoiceCloneRoutes(
  app: FastifyInstance,
  routeConfig: RouteGeneratorConfig,
  opts: RegisterVoiceCloneRoutesOpts,
): void {
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
    const authResult = await authenticateCloneRequest(req, routeConfig, cookieNames, opts.access);
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

    const upload = await readMultipartAudio(req, 'file');
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
      return reply.status(500).send({
        error: 'voice.clone.persist_failed',
        message:
          persistError instanceof Error
            ? persistError.message
            : 'Failed to persist clone ownership mapping',
      });
    }

    return reply.status(201).send({ voice: created });
  });

  app.get('/api/voice/providers/:providerId/clones', async (req, reply) => {
    const authResult = await authenticateCloneRequest(req, routeConfig, cookieNames, opts.access);
    if (!authResult.ok) {
      return reply.status(authResult.status).send(authResult.body);
    }
    const providerId = readProviderId(req);
    const voices = await opts.listOwnedClones({ providerId, auth: authResult.auth });
    return reply.send({ voices });
  });

  app.get('/api/voice/providers/:providerId/clones/:id', async (req, reply) => {
    const authResult = await authenticateCloneRequest(req, routeConfig, cookieNames, opts.access);
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
    const authResult = await authenticateCloneRequest(req, routeConfig, cookieNames, opts.access);
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
    const authResult = await authenticateCloneRequest(req, routeConfig, cookieNames, opts.access);
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
    const authResult = await authenticateCloneRequest(req, routeConfig, cookieNames, opts.access);
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
        routeConfig,
        cookieNames,
        referenceAccess,
      );
      if (!authResult.ok) {
        return reply.status(authResult.status).send(authResult.body);
      }
      const providerId = readProviderId(req);
      const upload = await readMultipartAudio(req, 'file');
      const text = readRequiredString(upload.fields, 'text');
      const locale = readOptionalString(upload.fields, 'locale');
      const model = readOptionalString(upload.fields, 'model');
      const registry = await resolveRegistry();
      const registration = registry.tts.get(providerId);
      if (registration?.clone) {
        try {
          assertCloneSampleWithinLimit(
            upload.audio,
            registration.clone.capabilities,
            opts.maxSampleBytes,
          );
        } catch (error) {
          if (error instanceof PlumbusError) {
            return reply
              .status(400)
              .send({ error: 'voice.clone.sample_too_large', message: error.message });
          }
          throw error;
        }
      }
      try {
        const audio = await synthesizeWithVoiceReference({
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
        return reply.header('content-type', 'application/octet-stream').send(Buffer.from(audio));
      } catch (error) {
        return reply.status(mapVendorErrorStatus(error)).send(mapVendorErrorBody(error));
      }
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
  routeConfig: RouteGeneratorConfig,
  cookieNames: string[],
  access: RegisterVoiceCloneRoutesOpts['access'],
): Promise<{ ok: true; auth: VoiceCloneAuth } | { ok: false; status: number; body: unknown }> {
  const token = resolveAuthToken(req, cookieNames);
  const auth = await routeConfig.authAdapter.authenticate(token);
  if (!auth) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
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

function resolveAuthToken(req: FastifyRequest, cookieNames: string[]): string | undefined {
  const headerToken = req.headers.authorization;
  if (headerToken) return headerToken;

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const cookieName of cookieNames) {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim();
      if (key !== cookieName) continue;
      return `Bearer ${decodeURIComponent(part.slice(eq + 1).trim())}`;
    }
  }
  return undefined;
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

async function readMultipartAudio(
  req: FastifyRequest,
  fileField: string,
): Promise<MultipartAudioResult> {
  const request = req as FastifyRequest & {
    file?: () => Promise<
      | {
          file: AsyncIterable<Buffer>;
          filename: string;
          mimetype: string;
          fields: Record<string, { value?: string } | undefined>;
        }
      | undefined
    >;
    parts?: () => AsyncIterable<{
      type: string;
      fieldname: string;
      value?: string;
      filename?: string;
      mimetype?: string;
      toBuffer?: () => Promise<Buffer>;
      file?: AsyncIterable<Buffer>;
    }>;
  };

  if (typeof request.file === 'function') {
    const file = await request.file();
    if (!file) {
      throw new PlumbusError(ErrorCode.Validation, `Multipart field "${fileField}" is required`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const fields: Record<string, string> = {};
    for (const [key, entry] of Object.entries(file.fields ?? {})) {
      if (entry && typeof entry.value === 'string') {
        fields[key] = entry.value;
      }
    }
    return {
      audio: Buffer.concat(chunks),
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
    for await (const part of request.parts()) {
      if (part.type === 'file' && part.fieldname === fileField) {
        if (typeof part.toBuffer === 'function') {
          audio = await part.toBuffer();
        } else if (part.file) {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          audio = Buffer.concat(chunks);
        }
        filename = part.filename || filename;
        mimeType = part.mimetype;
      } else if (part.type !== 'file' && typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
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

function mapVendorErrorBody(error: unknown): unknown {
  if (error instanceof PlumbusError) {
    return { error: error.code, message: error.message, metadata: error.metadata };
  }
  return {
    error: 'voice.clone.vendor_error',
    message: error instanceof Error ? error.message : String(error),
  };
}
