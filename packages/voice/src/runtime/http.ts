import {
  createExecutionContext,
  evaluateAccess,
  ErrorCode,
  PlumbusError,
  type ExecutionContext,
  type RouteGeneratorConfig,
} from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createSTTProvider,
  createTTSProvider,
  createTransportProvider,
} from '../providers/factory.js';
import {
  createProviderRegistry,
  validateVoiceProviders,
  type VoiceProviderRegistry,
} from '../providers/registry.js';
import type {
  WebSocketTransportProvider,
  AttachWebSocketTransportArgs,
} from '../providers/transport/websocket-transport.js';
import type { TransportProvider } from '../providers/base/transport-provider.js';
import { mintVoiceSessionToken, verifyVoiceSessionToken } from '../security/session-token.js';
import { checkWebSocketOrigin } from '../security/ws-origin.js';
import type { RegisterVoiceRoutesOpts, VoiceBeforeSessionResult } from '../types/http.js';
import type { VoiceDefinition } from '../types/voice.js';
import { registerVoiceCatalogRoutes } from './http-catalog.js';
import { createVoiceSessionBudget } from '../cost/session-budget.js';
import { resolveSttMode, VoiceSessionController } from './voice-session-controller.js';
import { createVoiceSessionLifecycle } from './session-lifecycle.js';
import {
  readNoiseCancellationFromTransportOptions,
  serializeNoiseCancellation,
} from './noise-cancellation/parse-noise-cancellation.js';

const voiceSessionBodySchema = z
  .object({
    voiceName: z.string().optional(),
  })
  .passthrough();

function parseVoiceSessionBody(
  body: unknown,
): Record<string, unknown> | { error: { status: number; body: unknown } } {
  const parsed = voiceSessionBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      error: {
        status: 400,
        body: {
          error: 'voice.invalid_request_body',
          issues: parsed.error.issues,
        },
      },
    };
  }
  return parsed.data;
}

function isParsedBodyError(
  parsedBody: Record<string, unknown> | { error: { status: number; body: unknown } },
): parsedBody is { error: { status: number; body: unknown } } {
  return 'error' in parsedBody;
}

function isBeforeSessionError(
  before: VoiceBeforeSessionResult | undefined,
): before is Extract<VoiceBeforeSessionResult, { error: { status: number; body: unknown } }> {
  return Boolean(before && 'error' in before);
}

function getBeforeSessionSuccess(
  before: VoiceBeforeSessionResult | undefined,
): Extract<VoiceBeforeSessionResult, { room?: unknown; execution?: unknown }> | undefined {
  if (!before || isBeforeSessionError(before)) {
    return undefined;
  }
  return before;
}

function installHintResponse(error: unknown): { status: 400; body: unknown } | undefined {
  if (!(error instanceof PlumbusError)) {
    return undefined;
  }
  const installPackage = error.metadata?.installPackage;
  if (typeof installPackage !== 'string') {
    return undefined;
  }
  return {
    status: 400,
    body: {
      error: 'voice.provider_package_missing',
      installPackage,
      message: error.message,
    },
  };
}

function packageValidationResponse(providerId: string, issues: unknown[]) {
  return {
    error: 'voice.provider_not_registered',
    provider: providerId,
    issues,
  };
}

function defaultRoomTokenPayload(
  minted: { sessionId: string; transport: string; metadata?: Record<string, unknown> },
  transportProviderId: string,
): Record<string, unknown> | undefined {
  const metadata = minted.metadata ?? {};
  const url = metadata.url;
  const token = metadata.token;
  const room = metadata.room;
  if (typeof url !== 'string' || typeof token !== 'string' || typeof room !== 'string') {
    return undefined;
  }
  const audioTrackName =
    typeof metadata.audioTrackName === 'string' ? metadata.audioTrackName : undefined;
  return {
    transport: transportProviderId,
    url,
    token,
    room,
    identity: typeof metadata.identity === 'string' ? metadata.identity : undefined,
    audioTrackName,
    agentAudioTrackName: audioTrackName,
    audioFormat: typeof metadata.audioFormat === 'string' ? metadata.audioFormat : undefined,
    mode: typeof metadata.mode === 'string' ? metadata.mode : undefined,
    sessionId: minted.sessionId,
  };
}

export function registerVoiceRoutes(
  app: FastifyInstance,
  routeConfig: RouteGeneratorConfig,
  voices: VoiceDefinition[],
  opts: RegisterVoiceRoutesOpts,
): void {
  const needsWebsocketPlugin = voices.some((voice) => voice.transport.provider === 'websocket');
  const canNestRegister = typeof app.register === 'function';

  if (!needsWebsocketPlugin || !canNestRegister) {
    registerVoiceRoutesOnApp(app, routeConfig, voices, opts);
    return;
  }

  void app.register(async (voiceApp) => {
    await voiceApp.register(websocket);
    registerVoiceRoutesOnApp(voiceApp, routeConfig, voices, opts);
  });
}

function registerVoiceRoutesOnApp(
  app: FastifyInstance,
  routeConfig: RouteGeneratorConfig,
  voices: VoiceDefinition[],
  opts: RegisterVoiceRoutesOpts,
): void {
  const byName = new Map(voices.map((voice) => [voice.name, voice]));
  let cachedRegistry: VoiceProviderRegistry | undefined = opts.registry;
  const resolveRegistry = async (): Promise<VoiceProviderRegistry> => {
    if (opts.resolveRegistry) {
      return opts.resolveRegistry();
    }
    if (cachedRegistry) return cachedRegistry;
    cachedRegistry = createProviderRegistry();
    return cachedRegistry;
  };
  const cookieNames = opts.authCookieNames ?? [];

  registerVoiceCatalogRoutes(app, routeConfig, voices, { ...opts, resolveRegistry });

  for (const voice of voices) {
    const voiceName = voice.name;

    app.post(`/api/voice/${voiceName}/session`, async (req, reply) => {
      const authResult = await authenticateVoiceRequest(req, routeConfig, cookieNames, voice);
      if (!authResult.ok) {
        return reply.status(authResult.status).send(authResult.body);
      }

      const { ctx, auth } = authResult;
      const parsedBody = parseVoiceSessionBody(req.body ?? {});
      if (isParsedBodyError(parsedBody)) {
        return reply.status(parsedBody.error.status).send(parsedBody.error.body);
      }
      const before = await opts.beforeSession?.(ctx, voice, parsedBody);
      if (isBeforeSessionError(before)) {
        return reply.status(before.error.status).send(before.error.body);
      }

      if (voice.transport.provider !== 'websocket') {
        return reply.status(400).send({ error: 'Voice does not use the websocket transport' });
      }

      const registry = await resolveRegistry();
      const validation = validateVoiceProviders({
        voices: [voice],
        providers: opts.providers,
        registry,
      });
      if (!validation.ok) {
        const packageIssue = validation.issues.find((issue) => issue.field === 'package');
        if (packageIssue) {
          return reply
            .status(400)
            .send(packageValidationResponse(packageIssue.provider, validation.issues));
        }
        return reply.status(400).send({
          error: 'Voice provider configuration is invalid',
          issues: validation.issues,
        });
      }

      let transport: WebSocketTransportProvider;
      try {
        transport = createTransportProvider({
          registry,
          providers: opts.providers,
          voiceSlice: voice.transport,
        }) as WebSocketTransportProvider;
      } catch (error) {
        const hint = installHintResponse(error);
        if (hint) {
          return reply.status(hint.status).send(hint.body);
        }
        throw error;
      }

      const minted = await transport.mintSession({
        voiceName,
        userId: auth.userId,
      });
      const sessionToken = mintVoiceSessionToken({
        secret: resolveSessionTokenSecret(opts, ctx),
        auth,
        issuer: opts.sessionTokenIssuer,
        expiresInSeconds: opts.sessionTokenTtlSeconds,
        claims: {
          voiceName,
          sessionId: minted.sessionId,
          transport: 'websocket',
        },
      });

      const wsUrl = buildWebSocketUrl(req, voiceName);
      const body = {
        wsUrl,
        sessionToken,
        audioFormat: voice.transport.audioFormat ?? 'pcm16-16k',
        sessionId: minted.sessionId,
        sttMode: resolveSttMode(voice),
      };

      await opts.afterSession?.(ctx, voice, body);
      return reply.send(body);
    });

    app.post(`/api/voice/${voiceName}/token`, async (req, reply) => {
      const authResult = await authenticateVoiceRequest(req, routeConfig, cookieNames, voice);
      if (!authResult.ok) {
        return reply.status(authResult.status).send(authResult.body);
      }

      const { ctx, auth } = authResult;
      const parsedBody = parseVoiceSessionBody(req.body ?? {});
      if (isParsedBodyError(parsedBody)) {
        return reply.status(parsedBody.error.status).send(parsedBody.error.body);
      }
      const before = await opts.beforeSession?.(ctx, voice, parsedBody);
      if (isBeforeSessionError(before)) {
        return reply.status(before.error.status).send(before.error.body);
      }

      if (voice.transport.provider === 'websocket') {
        return reply.status(400).send({
          error: 'Voice websocket transport uses /session, not /token',
        });
      }

      const registry = await resolveRegistry();
      const validation = validateVoiceProviders({
        voices: [voice],
        providers: opts.providers,
        registry,
      });
      if (!validation.ok) {
        const packageIssue = validation.issues.find((issue) => issue.field === 'package');
        if (packageIssue) {
          return reply
            .status(400)
            .send(packageValidationResponse(packageIssue.provider, validation.issues));
        }
        return reply.status(400).send({
          error: 'Voice provider configuration is invalid',
          issues: validation.issues,
        });
      }

      const registration = registry.transport.get(voice.transport.provider);
      let transport: TransportProvider;
      try {
        transport = createTransportProvider({
          registry,
          providers: opts.providers,
          voiceSlice: voice.transport,
        });
      } catch (error) {
        const hint = installHintResponse(error);
        if (hint) {
          return reply.status(hint.status).send(hint.body);
        }
        throw error;
      }

      if (typeof transport.mintSession !== 'function') {
        return reply.status(400).send({
          error: 'Voice transport does not support session minting via /token',
          transport: voice.transport.provider,
        });
      }

      const beforeSuccess = getBeforeSessionSuccess(before);
      const roomOpts = beforeSuccess?.room;
      const minted = await transport.mintSession({
        voiceName,
        userId: beforeSuccess?.execution?.userId ?? auth.userId,
        roomName: roomOpts?.roomName,
        identity: roomOpts?.identity,
        metadata: roomOpts?.metadata,
        attributes: roomOpts?.attributes,
        tokenTtlSeconds: roomOpts?.tokenTtlSeconds,
      });

      const mapped =
        registration?.toClientSessionPayload?.(minted, {
          voiceName,
          transportProviderId: voice.transport.provider,
        }) ?? defaultRoomTokenPayload(minted, voice.transport.provider);

      if (!mapped) {
        return reply.status(400).send({
          error: 'Voice transport mintSession did not produce a client token payload',
          transport: voice.transport.provider,
        });
      }

      const noiseCancellation = readNoiseCancellationFromTransportOptions(voice.transport.options);
      const body = {
        ...mapped,
        transport: voice.transport.provider,
        sessionId: minted.sessionId,
        sttMode: resolveSttMode(voice),
        noiseCancellation: serializeNoiseCancellation(noiseCancellation),
        execution: beforeSuccess?.execution,
      };

      await opts.afterSession?.(ctx, voice, body);
      return reply.send(body);
    });

    app.get(`/api/voice/${voiceName}/health`, async (req, reply) => {
      const authResult = await authenticateVoiceRequest(req, routeConfig, cookieNames, voice);
      if (!authResult.ok) {
        return reply.status(authResult.status).send(authResult.body);
      }

      const registry = await resolveRegistry();
      const validation = validateVoiceProviders({
        voices: [voice],
        providers: opts.providers,
        registry,
      });

      return reply.send({
        ok: true,
        voiceName,
        transport: voice.transport.provider,
        providersValidated: validation.ok,
      });
    });

    if (opts.enableDebugEventStream) {
      app.get(`/api/voice/${voiceName}/debug/events`, async (req, reply) => {
        const authResult = await authenticateVoiceRequest(req, routeConfig, cookieNames, voice);
        if (!authResult.ok) {
          return reply.status(authResult.status).send(authResult.body);
        }

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        reply.raw.write(`data: ${JSON.stringify({ type: 'debug.ready', voiceName })}\n\n`);

        const heartbeat = setInterval(() => {
          reply.raw.write(`data: ${JSON.stringify({ type: 'debug.heartbeat', voiceName })}\n\n`);
        }, 15_000);

        req.raw.on('close', () => {
          clearInterval(heartbeat);
        });
      });
    }

    app.get(`/api/voice/${voiceName}/stream`, { websocket: true }, (socket, req) => {
      void handleVoiceWebSocket(socket, req, {
        voice,
        voiceName,
        routeConfig,
        opts,
        resolveRegistry,
      });
    });
  }

  void byName;
}

async function handleVoiceWebSocket(
  socket: AttachWebSocketTransportArgs['socket'],
  req: FastifyRequest,
  args: {
    voice: VoiceDefinition;
    voiceName: string;
    routeConfig: RouteGeneratorConfig;
    opts: RegisterVoiceRoutesOpts;
    resolveRegistry: () => Promise<VoiceProviderRegistry>;
  },
): Promise<void> {
  const originCheck = checkWebSocketOrigin(req.headers.origin, {
    allowlist: args.opts.websocketOriginAllowlist,
  });
  if (!originCheck.ok) {
    socket.send(
      JSON.stringify({
        type: 'error',
        code: 'voice.origin_rejected',
        message: originCheck.reason ?? 'Origin rejected',
      }),
    );
    socket.close(1008, originCheck.reason ?? 'Origin rejected');
    return;
  }

  const sessionToken = extractSessionToken(req);
  if (!sessionToken) {
    socket.send(
      JSON.stringify({
        type: 'error',
        code: 'voice.unauthorized',
        message: 'Missing voice session token',
      }),
    );
    socket.close(1008, 'Unauthorized');
    return;
  }

  const secret = resolveSessionTokenSecret(args.opts, undefined);
  const verified = await verifyVoiceSessionToken({
    token: sessionToken,
    secret,
    issuer: args.opts.sessionTokenIssuer,
  });

  if (!verified || verified.claims.voiceName !== args.voiceName) {
    socket.send(
      JSON.stringify({
        type: 'error',
        code: 'voice.unauthorized',
        message: 'Invalid or expired voice session token',
      }),
    );
    socket.close(1008, 'Unauthorized');
    return;
  }

  if (args.voice.transport.provider !== 'websocket') {
    socket.send(
      JSON.stringify({
        type: 'error',
        code: 'voice.invalid_transport',
        message: 'Voice does not use websocket transport',
      }),
    );
    socket.close(1008, 'Invalid transport');
    return;
  }

  const auth = verified.auth;
  const deps = args.routeConfig.createDependencies(auth);
  deps.request = { sourceIp: req.ip, userAgent: req.headers['user-agent'] };
  const ctx = createExecutionContext(deps);

  const budget = createVoiceSessionBudget(args.opts.sessionBudget);
  const registry = await args.resolveRegistry();

  let transport: WebSocketTransportProvider;
  let sttProvider: ReturnType<typeof createSTTProvider>;
  let ttsProvider: ReturnType<typeof createTTSProvider>;
  try {
    transport = createTransportProvider({
      registry,
      providers: args.opts.providers,
      voiceSlice: args.voice.transport,
    }) as WebSocketTransportProvider;

    sttProvider = createSTTProvider({
      registry,
      providers: args.opts.providers,
      voiceSlice: args.voice.stt,
    });

    ttsProvider = createTTSProvider({
      registry,
      providers: args.opts.providers,
      voiceSlice: args.voice.tts,
    });
  } catch (error) {
    const hint = installHintResponse(error);
    if (hint) {
      socket.send(
        JSON.stringify({
          type: 'error',
          code:
            hint.body &&
            typeof hint.body === 'object' &&
            'error' in hint.body &&
            typeof (hint.body as { error: unknown }).error === 'string'
              ? (hint.body as { error: string }).error
              : 'voice.provider_package_missing',
          message:
            hint.body && typeof hint.body === 'object' && 'message' in hint.body
              ? String((hint.body as { message: unknown }).message)
              : 'Required voice provider package is missing',
          installPackage:
            hint.body && typeof hint.body === 'object' && 'installPackage' in hint.body
              ? (hint.body as { installPackage: unknown }).installPackage
              : undefined,
          loadError:
            hint.body && typeof hint.body === 'object' && 'loadError' in hint.body
              ? (hint.body as { loadError: unknown }).loadError
              : undefined,
        }),
      );
      socket.close(1011, 'Provider package missing');
      return;
    }
    throw error;
  }

  let controller!: VoiceSessionController;
  const lifecycle = createVoiceSessionLifecycle({
    maxSessionDurationSeconds:
      args.opts.sessionLifecycle?.maxSessionDurationSeconds ??
      args.opts.sessionBudget?.maxSessionDurationSeconds,
    idleTimeoutSeconds:
      args.opts.sessionLifecycle?.idleTimeoutSeconds ?? args.opts.sessionBudget?.idleTimeoutSeconds,
    onIdleTimeout: async () => {
      lifecycle.stop();
      await controller.notifyTransportLost('Voice session idle timeout exceeded');
      await controller.dispose();
      socket.close(1000, 'Idle timeout');
    },
    onMaxDuration: async () => {
      lifecycle.stop();
      await controller.notifyTransportLost('Voice session duration limit exceeded');
      await controller.dispose();
      socket.close(1000, 'Session duration exceeded');
    },
  });

  controller = new VoiceSessionController({
    voice: args.voice,
    sessionId: verified.claims.sessionId,
    userId: auth.userId,
    ctx,
    sttProvider,
    ttsProvider,
    transportProvider: transport,
    budget,
    onEvent: async (event) => {
      socket.send(JSON.stringify(event));
    },
    onAudioChunk: async (chunk) => {
      socket.send(chunk, { binary: true });
    },
    onActivity: () => {
      lifecycle.bumpActivity();
    },
  });
  lifecycle.start();

  transport.attachSocket({
    socket,
    onAudio: async (audio) => {
      await controller.handleAudioChunk(audio, controller.session.audioFormat);
    },
    onClose: async () => {
      lifecycle.stop();
      await controller.notifyTransportLost();
      await controller.dispose();
    },
  });

  await controller.hello();

  socket.on('message', (raw, isBinary) => {
    void (async () => {
      if (isBinary) {
        const chunk =
          typeof raw === 'string'
            ? Uint8Array.from(raw, (char) => char.charCodeAt(0) & 0xff)
            : new Uint8Array(raw);
        await controller.handleAudioChunk(chunk, controller.session.audioFormat);
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(
          typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8'),
        ) as Record<string, unknown>;
      } catch {
        await controller.handleControlMessage({
          type: 'error',
          code: 'voice.invalid_message',
          message: 'Expected JSON control frame',
        });
        return;
      }

      await controller.handleControlMessage(payload);
    })().catch(async (error) => {
      const message = error instanceof Error ? error.message : 'Voice websocket handler failed';
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'voice.runtime_error',
          message,
        }),
      );
    });
  });
}

async function authenticateVoiceRequest(
  req: FastifyRequest,
  routeConfig: RouteGeneratorConfig,
  cookieNames: string[],
  voice: VoiceDefinition,
): Promise<
  | {
      ok: true;
      ctx: ExecutionContext;
      auth: NonNullable<Awaited<ReturnType<RouteGeneratorConfig['authAdapter']['authenticate']>>>;
    }
  | { ok: false; status: number; body: unknown }
> {
  const token = resolveAuthToken(req, cookieNames);
  const auth = await routeConfig.authAdapter.authenticate(token);
  if (!auth) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }

  const authz = evaluateAccess(voice.access, auth);
  if (!authz.allowed) {
    return {
      ok: false,
      status: 403,
      body: {
        error: { code: 'forbidden', message: authz.reason ?? 'Access denied' },
      },
    };
  }

  const deps = routeConfig.createDependencies(auth);
  deps.request = { sourceIp: req.ip, userAgent: req.headers['user-agent'] };
  const ctx = createExecutionContext(deps);
  return { ok: true, ctx, auth };
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

function resolveSessionTokenSecret(
  opts: RegisterVoiceRoutesOpts,
  ctx: ExecutionContext | undefined,
): string {
  if (opts.sessionTokenSecret) {
    return opts.sessionTokenSecret;
  }

  const fromConfig = ctx?.config?.voiceSessionTokenSecret;
  if (typeof fromConfig === 'string' && fromConfig.length >= 32) {
    return fromConfig;
  }

  throw new PlumbusError(
    ErrorCode.DependencyViolation,
    'Voice session token secret is required — set RegisterVoiceRoutesOpts.sessionTokenSecret or ctx.config.voiceSessionTokenSecret',
  );
}

function buildWebSocketUrl(req: FastifyRequest, voiceName: string): string {
  const host = req.headers.host ?? 'localhost';
  const forwardedProto = req.headers['x-forwarded-proto'];
  const isSecure =
    forwardedProto === 'https' ||
    (typeof forwardedProto === 'string' && forwardedProto.split(',')[0]?.trim() === 'https');
  const protocol = isSecure ? 'wss' : 'ws';
  return `${protocol}://${host}/api/voice/${voiceName}/stream`;
}

function extractSessionToken(req: FastifyRequest): string | undefined {
  const protocolHeader = req.headers['sec-websocket-protocol'];
  const protocols =
    typeof protocolHeader === 'string'
      ? protocolHeader.split(',').map((value) => value.trim())
      : [];

  for (const protocol of protocols) {
    if (protocol.startsWith('voice-session.')) {
      return protocol.slice('voice-session.'.length);
    }
  }

  const query = req.query as { sessionToken?: string };
  if (typeof query.sessionToken === 'string' && query.sessionToken.length > 0) {
    return query.sessionToken;
  }

  return undefined;
}
