import { createTestContext } from '@plumbus/core/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { defineVoice } from '../../define/defineVoice.js';
import { resetVoiceWarningsForTests } from '../../internal/warn-once.js';
import type { TTSProviderRegistration } from '../../providers/base/provider-registration.js';
import { createProviderRegistry } from '../../providers/registry.js';
import { VOICE_CSRF_COOKIE_NAME, VOICE_CSRF_HEADER_NAME } from '../../security/csrf-names.js';
import { ConsumedVoiceTokenStore } from '../../security/session-token.js';
import { checkWebSocketOrigin } from '../../security/ws-origin.js';
import {
  createMockSTTProvider,
  createMockTransportProvider,
  createMockTTSProvider,
} from '../../testing/index.js';
import type { VoiceCloneProvider } from '../../types/clone.js';
import type { RegisterVoiceCloneRoutesOpts, RegisterVoiceRoutesOpts } from '../../types/http.js';
import { registerVoiceRoutes } from '../http.js';
import { registerVoiceCloneRoutes } from '../http-clone.js';
import { runVoiceTurn } from '../run-turn.js';

const SECRET = 'voice-session-secret-for-tests-1234567890';
const CSRF_SECRET = 'voice-csrf-secret-for-tests-1234567890';
const BASE_URL = 'https://app.example.com';
const SAMPLE_LIMIT = 10_000;
const USER = { userId: 'user-1', roles: ['user'], scopes: [], provider: 'test' };

function depsFromAuth(auth: typeof USER) {
  const ctx = createTestContext({ auth });
  return {
    auth: ctx.auth,
    data: ctx.data,
    events: ctx.events,
    flows: ctx.flows,
    ai: ctx.ai,
    audit: ctx.audit,
    logger: ctx.logger,
    time: ctx.time,
    config: { voiceSessionTokenSecret: SECRET },
    security: ctx.security,
    translations: ctx.translations,
  };
}

const routeConfig = {
  db: null as never,
  authAdapter: {
    authenticate: async (header?: string) => (header === 'Bearer user-token' ? USER : null),
  },
  createDependencies: (auth: typeof USER) => depsFromAuth(auth),
} as never;

const socketVoice = defineVoice({
  name: 'socketVoice',
  access: {},
  transport: { provider: 'websocket' },
  stt: { provider: 'web-speech' },
  tts: { provider: 'browser-tts', locale: 'en-US', voiceId: 'browser-default' },
  brain: {
    async run() {
      return { text: 'ok' };
    },
  },
});

function voiceApp(extra: Partial<RegisterVoiceRoutesOpts> = {}): FastifyInstance {
  const app = Fastify();
  registerVoiceRoutes(app, routeConfig, [socketVoice], {
    providers: { providers: { 'web-speech': {}, 'browser-tts': {}, websocket: {} } },
    sessionTokenSecret: SECRET,
    websocketOriginAllowlist: [BASE_URL],
    ...extra,
  });
  return app;
}

const CLONE_CAPABILITIES = {
  supported: true as const,
  readiness: 'immediate' as const,
  supportsPersistedCreate: true as const,
  supportsInstantReference: true,
  maxSampleBytes: SAMPLE_LIMIT,
  requiresGender: false,
  requiresLocale: false,
  supportsRecompute: false,
  supportsDelete: true as const,
  supportsList: true as const,
  supportsGet: true as const,
};

function cloneImpl(overrides: Partial<VoiceCloneProvider> = {}): VoiceCloneProvider {
  return {
    providerId: 'fake-clone',
    capabilities: CLONE_CAPABILITIES,
    async create() {
      return { id: 'v1', providerId: 'fake-clone', displayName: 'v1', status: 'ready' };
    },
    async get() {
      return null;
    },
    async list() {
      return { voices: [] };
    },
    async delete() {},
    async waitUntilReady(id) {
      return { id, providerId: 'fake-clone', displayName: id, status: 'ready' };
    },
    ...overrides,
  };
}

function cloneRegistry(impl: VoiceCloneProvider) {
  const registration: TTSProviderRegistration = {
    descriptor: {
      id: 'fake-clone',
      kind: 'tts',
      displayName: 'Fake',
      credentialSchema: [],
      hosting: 'cloud',
      execution: 'server',
      streaming: true,
      toneSupport: 'none',
      deliveryAxes: [],
      deliveryMode: 'none',
      knownModels: [],
    },
    create() {
      return { capabilities: this.descriptor, mapDeliveryTone: () => ({}) };
    },
    clone: {
      capabilities: CLONE_CAPABILITIES,
      create: () => impl,
      async synthesizeWithVoiceReference(_c, input) {
        return new TextEncoder().encode(input.text);
      },
    },
  };
  return createProviderRegistry({ includeBuiltins: false, tts: { 'fake-clone': registration } });
}

function cloneApp(
  impl: VoiceCloneProvider = cloneImpl(),
  extra: Partial<RegisterVoiceCloneRoutesOpts> = {},
): FastifyInstance {
  const app = Fastify();
  registerVoiceCloneRoutes(app, routeConfig, {
    providers: { providers: { 'fake-clone': { apiKey: 'k' } } },
    registry: cloneRegistry(impl),
    access: { public: true },
    referenceAccess: { public: true },
    resolveCloneOwner: async () => 'user-1',
    afterCloneCreate: async () => {},
    listOwnedClones: async () => [],
    ...extra,
  });
  return app;
}

/** Streamed upload of `chunkCount` 1000-byte chunks; records how many were pulled. */
function streamedUpload(chunkCount: number) {
  const state = { pulled: 0, limitsSeen: undefined as unknown };
  async function* chunks() {
    for (let i = 0; i < chunkCount; i += 1) {
      state.pulled += 1;
      yield Buffer.alloc(1000, 1);
    }
  }
  const fileFn = async (options?: { limits?: { fileSize?: number } }) => {
    state.limitsSeen = options?.limits;
    return {
      file: chunks(),
      filename: 'sample.wav',
      mimetype: 'audio/wav',
      fields: { name: { value: 'n' }, text: { value: 'hello' } },
    };
  };
  const partsFn = (options?: { limits?: { fileSize?: number } }) => {
    state.limitsSeen = options?.limits;
    return (async function* () {
      yield { type: 'field', fieldname: 'name', value: 'n' };
      yield { type: 'field', fieldname: 'text', value: 'hello' };
      yield {
        type: 'file',
        fieldname: 'file',
        filename: 'sample.wav',
        mimetype: 'audio/wav',
        file: chunks(),
        toBuffer: async () => {
          throw new Error('toBuffer must not be used');
        },
      };
    })();
  };
  return { state, fileFn, partsFn };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetVoiceWarningsForTests();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

function warnings(): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

describe('clone uploads are size-limited while streaming', () => {
  for (const mode of ['file', 'parts'] as const) {
    for (const route of ['clones', 'synthesize-reference'] as const) {
      it(`stops reading an oversized ${route} upload early (${mode}())`, async () => {
        const create = vi.fn(cloneImpl().create);
        const app = cloneApp(cloneImpl({ create }));
        const upload = streamedUpload(1000); // 1 MB offered, limit is 10 kB
        app.addHook('onRequest', async (req) => {
          if (mode === 'file') (req as unknown as { file: unknown }).file = upload.fileFn;
          else (req as unknown as { parts: unknown }).parts = upload.partsFn;
        });
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/providers/fake-clone/${route}`,
          headers: { authorization: 'Bearer user-token' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({
          error: 'voice.clone.sample_too_large',
          message: `Voice clone sample exceeds maxSampleBytes (${SAMPLE_LIMIT})`,
        });
        expect(upload.state.pulled).toBeLessThanOrEqual(SAMPLE_LIMIT / 1000 + 1);
        expect(upload.state.limitsSeen).toEqual({ fileSize: SAMPLE_LIMIT + 1 });
        expect(create).not.toHaveBeenCalled();
        await app.close();
      });
    }
  }

  it('honours a smaller maxSampleBytes route override while streaming', async () => {
    const app = cloneApp(cloneImpl(), { maxSampleBytes: 2_000 });
    const upload = streamedUpload(50);
    app.addHook('onRequest', async (req) => {
      (req as unknown as { file: unknown }).file = upload.fileFn;
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/providers/fake-clone/clones',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(upload.state.pulled).toBeLessThanOrEqual(3);
    await app.close();
  });

  it('maps the multipart plugin size error to the same validation response', async () => {
    const app = cloneApp();
    app.addHook('onRequest', async (req) => {
      (req as unknown as { file: unknown }).file = async () => ({
        file: (async function* () {
          yield Buffer.alloc(10);
          throw Object.assign(new Error('request file too large'), {
            code: 'FST_REQ_FILE_TOO_LARGE',
          });
        })(),
        filename: 'a.wav',
        mimetype: 'audio/wav',
        fields: { name: { value: 'n' } },
      });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/providers/fake-clone/clones',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('voice.clone.sample_too_large');
    await app.close();
  });

  it('still accepts a sample within the limit', async () => {
    const app = cloneApp();
    const upload = streamedUpload(5);
    app.addHook('onRequest', async (req) => {
      (req as unknown as { file: unknown }).file = upload.fileFn;
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/providers/fake-clone/clones',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(res.statusCode).toBe(201);
    expect(upload.state.pulled).toBe(5);
    await app.close();
  });
});

describe('clone errors sent to clients', () => {
  function withSmallUpload(app: FastifyInstance) {
    const upload = streamedUpload(1);
    app.addHook('onRequest', async (req) => {
      (req as unknown as { file: unknown }).file = upload.fileFn;
    });
  }

  it('hides vendor error text and keeps it in the server log', async () => {
    const app = cloneApp(
      cloneImpl({
        async create() {
          throw new Error('vendor said: api key sk-live-123 rejected');
        },
      }),
    );
    withSmallUpload(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/providers/fake-clone/clones',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'voice.clone.vendor_error',
      message: 'Voice clone provider request failed',
    });
    expect(res.body).not.toContain('sk-live-123');
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('sk-live-123');
    await app.close();
  });

  it('keeps the PlumbusError code but drops message and metadata', async () => {
    const { PlumbusError, ErrorCode } = await import('@plumbus/core/errors');
    const app = cloneApp(
      cloneImpl({
        async create() {
          throw new PlumbusError(ErrorCode.Validation, 'vendor detail', { internal: 'x' });
        },
      }),
    );
    withSmallUpload(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/providers/fake-clone/clones',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: ErrorCode.Validation,
      message: 'Voice clone request was rejected',
    });
    await app.close();
  });

  it('does not echo afterCloneCreate errors', async () => {
    const app = cloneApp(cloneImpl(), {
      afterCloneCreate: async () => {
        throw new Error('db password=hunter2');
      },
    });
    withSmallUpload(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/providers/fake-clone/clones',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json().error).toBe('voice.clone.persist_failed');
    await app.close();
  });
});

describe('cookie-authenticated voice writes (Origin + CSRF opt-in)', () => {
  const cookie = 'voice_auth=user-token';

  it('keeps accepting cookie auth without options and warns once', async () => {
    const app = voiceApp({ authCookieNames: ['voice_auth'] });
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/socketVoice/session',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(warnings().filter((w) => w.includes('without Origin/CSRF')).length).toBe(1);
    await app.close();
  });

  it('enforces exact Origin and the CSRF token when configured', async () => {
    const app = voiceApp({
      authCookieNames: ['voice_auth'],
      csrfSecret: CSRF_SECRET,
      externalBaseUrl: BASE_URL,
    });
    const post = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/voice/socketVoice/session', headers });

    expect((await post({ cookie, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post({ cookie })).statusCode).toBe(403);

    const first = await post({ cookie, origin: BASE_URL });
    expect(first.statusCode).toBe(200);
    const setCookie = String(first.headers['set-cookie']);
    expect(setCookie).toContain(`${VOICE_CSRF_COOKIE_NAME}=`);
    expect(setCookie).toContain('Secure');
    const csrf = setCookie.split(';')[0]?.split('=')[1] ?? '';

    const withCsrfCookie = `${cookie}; ${VOICE_CSRF_COOKIE_NAME}=${csrf}`;
    expect((await post({ cookie: withCsrfCookie, origin: BASE_URL })).statusCode).toBe(403);
    expect(
      (
        await post({
          cookie: withCsrfCookie,
          origin: BASE_URL,
          [VOICE_CSRF_HEADER_NAME]: 'forged.token',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await post({ cookie: withCsrfCookie, origin: BASE_URL, [VOICE_CSRF_HEADER_NAME]: csrf }))
        .statusCode,
    ).toBe(200);

    // Authorization-header requests are not browser-ambient and are unaffected.
    expect((await post({ authorization: 'Bearer user-token' })).statusCode).toBe(200);
    // Reads stay open to cookie auth from any origin.
    const health = await app.inject({
      method: 'GET',
      url: '/api/voice/socketVoice/health',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(health.statusCode).toBe(200);
    await app.close();
  });

  it('guards clone mutations but not clone reads', async () => {
    const app = cloneApp(cloneImpl(), {
      authCookieNames: ['voice_auth'],
      csrfSecret: CSRF_SECRET,
      externalBaseUrl: BASE_URL,
    });
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/voice/providers/fake-clone/clones/v1',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(del.statusCode).toBe(403);
    expect(del.json()).toEqual({
      error: { code: 'voice.origin_invalid', message: 'Request origin rejected' },
    });
    const ok = await app.inject({
      method: 'DELETE',
      url: '/api/voice/providers/fake-clone/clones/v1',
      headers: { cookie, origin: BASE_URL },
    });
    expect(ok.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: '/api/voice/providers/fake-clone/clones',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a malformed externalBaseUrl at registration', () => {
    expect(() => voiceApp({ externalBaseUrl: 'app.example.com' })).toThrow(/externalBaseUrl/);
  });
});

describe('websocket URL returned by /session', () => {
  it('uses externalBaseUrl instead of request headers when configured', async () => {
    const app = voiceApp({ externalBaseUrl: BASE_URL });
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/socketVoice/session',
      headers: {
        authorization: 'Bearer user-token',
        host: 'attacker.example',
        'x-forwarded-proto': 'http',
      },
    });
    expect(res.json().wsUrl).toBe('wss://app.example.com/api/voice/socketVoice/stream');
    expect(warnings().some((w) => w.includes('wsUrl is built from the request'))).toBe(false);
    await app.close();
  });

  it('maps http base URLs to ws://', async () => {
    const app = voiceApp({ externalBaseUrl: 'http://localhost:3000' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/socketVoice/session',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(res.json().wsUrl).toBe('ws://localhost:3000/api/voice/socketVoice/stream');
    await app.close();
  });

  it('keeps the header-derived URL without externalBaseUrl and warns once', async () => {
    const app = voiceApp();
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/voice/socketVoice/session',
        headers: {
          authorization: 'Bearer user-token',
          host: 'voice.local:8080',
          'x-forwarded-proto': 'https',
        },
      });
      expect(res.json().wsUrl).toBe('wss://voice.local:8080/api/voice/socketVoice/stream');
    }
    expect(warnings().filter((w) => w.includes('wsUrl is built from the request')).length).toBe(1);
    await app.close();
  });
});

describe('websocket handshake token hardening', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length > 0) await apps.pop()?.close();
  });

  async function start(extra: Partial<RegisterVoiceRoutesOpts>) {
    const app = voiceApp(extra);
    apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const base = `127.0.0.1:${address.port}`;
    const mint = async () => {
      const res = await fetch(`http://${base}/api/voice/socketVoice/session`, {
        method: 'POST',
        headers: { authorization: 'Bearer user-token' },
      });
      return ((await res.json()) as { sessionToken: string }).sessionToken;
    };
    return { base, mint };
  }

  function firstFrame(url: string, protocols: string[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, protocols, { origin: BASE_URL });
      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          resolve(data.toString());
          socket.close();
        }
      });
      socket.once('close', () => resolve('closed'));
      socket.once('error', reject);
    });
  }

  it('accepts query-string tokens by default', async () => {
    const { base, mint } = await start({});
    const token = await mint();
    const frame = await firstFrame(
      `ws://${base}/api/voice/socketVoice/stream?sessionToken=${token}`,
    );
    expect(frame).toContain('session.hello');
  });

  it('rejects query-string tokens with rejectQuerySessionToken', async () => {
    const { base, mint } = await start({ rejectQuerySessionToken: true });
    const token = await mint();
    const viaQuery = await firstFrame(
      `ws://${base}/api/voice/socketVoice/stream?sessionToken=${token}`,
    );
    expect(viaQuery).toContain('voice.unauthorized');
    const viaProtocol = await firstFrame(`ws://${base}/api/voice/socketVoice/stream`, [
      `voice-session.${token}`,
    ]);
    expect(viaProtocol).toContain('session.hello');
  });

  it('allows token reuse by default', async () => {
    const { base, mint } = await start({});
    const token = await mint();
    const url = `ws://${base}/api/voice/socketVoice/stream`;
    expect(await firstFrame(url, [`voice-session.${token}`])).toContain('session.hello');
    expect(await firstFrame(url, [`voice-session.${token}`])).toContain('session.hello');
  });

  it('accepts each token once with singleUseSessionTokens', async () => {
    const { base, mint } = await start({ singleUseSessionTokens: true });
    const token = await mint();
    const url = `ws://${base}/api/voice/socketVoice/stream`;
    expect(await firstFrame(url, [`voice-session.${token}`])).toContain('session.hello');
    expect(await firstFrame(url, [`voice-session.${token}`])).toContain('voice.unauthorized');
    const fresh = await mint();
    expect(await firstFrame(url, [`voice-session.${fresh}`])).toContain('session.hello');
  });
});

describe('consumed token store', () => {
  it('rejects replays until expiry and stays bounded', () => {
    const store = new ConsumedVoiceTokenStore(2);
    const now = 1_000;
    expect(store.consume('a', now + 100, now)).toBe(true);
    expect(store.consume('a', now + 100, now)).toBe(false);
    expect(store.consume('b', now + 100, now)).toBe(true);
    expect(store.consume('c', now + 100, now)).toBe(true);
    expect(store.size).toBe(2);
    // expired ids are pruned before live ones are evicted
    expect(store.consume('d', now + 500, now + 200)).toBe(true);
    expect(store.size).toBeLessThanOrEqual(2);
  });
});

describe('websocket Origin allowlist', () => {
  it('still allows any Origin when empty, with a one-time warning', () => {
    expect(checkWebSocketOrigin(undefined).ok).toBe(true);
    expect(checkWebSocketOrigin('https://anything.example').ok).toBe(true);
    expect(warnings().filter((w) => w.includes('websocketOriginAllowlist is empty')).length).toBe(
      1,
    );
  });
});

describe('runVoiceTurn client errors', () => {
  it('sends a generic message and logs the raw error', async () => {
    const ctx = createTestContext({ auth: USER });
    const voice = defineVoice({
      name: 'failingVoice',
      access: {},
      transport: { provider: 'mock-transport' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run() {
          throw new Error('upstream token sk-secret-999 invalid');
        },
      },
    });
    const events: Array<{ type: string; message?: string; code?: string }> = [];
    for await (const event of runVoiceTurn(ctx, {
      voiceDefinition: voice,
      sessionId: '00000000-0000-4000-8000-000000000001',
      transcript: 'hi there',
      sttProvider: createMockSTTProvider(),
      ttsProvider: createMockTTSProvider(),
      transportProvider: createMockTransportProvider(),
    })) {
      events.push(event as never);
    }
    const failure = events.find((e) => e.type === 'turn.failed');
    expect(failure).toMatchObject({ code: 'voice.runtime_error', message: 'Voice turn failed' });
    expect(JSON.stringify(events)).not.toContain('sk-secret-999');
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('sk-secret-999');
  });
});
