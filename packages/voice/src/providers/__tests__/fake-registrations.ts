import { fetchCatalogJson, normalizeVoiceList } from '../base/catalog-http.js';
import type {
  STTProviderRegistration,
  TTSProviderRegistration,
  TransportProviderRegistration,
} from '../base/provider-registration.js';
import type { STTProvider } from '../base/stt-provider.js';
import type { TransportProvider } from '../base/transport-provider.js';
import type { TTSProvider } from '../base/tts-provider.js';
import type { STTProviderCatalogEntry, TTSProviderCatalogEntry } from '../../types/provider.js';
import type { TransportProviderCapabilities } from '../base/capabilities.js';

/** Unsigned JWT-shaped token for local fake room mintSession (no vendor SDK). */
function fakeRoomParticipantToken(args: {
  room: string;
  identity: string;
  metadata?: string;
  attributes?: Record<string, string>;
  agentName?: string;
  agentMetadata?: string;
  ttlSeconds?: number;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: args.identity,
      video: { room: args.room, roomJoin: true },
      metadata: args.metadata,
      attributes: args.attributes,
      exp: Math.floor(Date.now() / 1000) + (args.ttlSeconds ?? 3600),
      roomConfig: args.agentName
        ? {
            agents: [
              {
                agentName: args.agentName,
                metadata: args.agentMetadata ?? args.metadata ?? '',
              },
            ],
          }
        : undefined,
    }),
  ).toString('base64url');
  return `${header}.${payload}.`;
}

function resolveTtsDescriptor(
  id: string,
  descriptor?: TTSProviderCatalogEntry,
): TTSProviderCatalogEntry {
  if (descriptor) return descriptor;
  return {
    id,
    kind: 'tts',
    displayName: id,
    credentialSchema: [{ field: 'apiKey', required: true }],
    hosting: 'cloud',
    execution: 'server',
    streaming: true,
    toneSupport: 'none',
    deliveryAxes: [],
    deliveryMode: 'none',
    knownModels: [],
    voicesSource: 'live-api',
  };
}

function resolveSttDescriptor(
  id: string,
  descriptor?: STTProviderCatalogEntry,
): STTProviderCatalogEntry {
  if (descriptor) return descriptor;
  return {
    id,
    kind: 'stt',
    displayName: id,
    credentialSchema: [{ field: 'apiKey', required: true }],
    hosting: 'cloud',
    execution: 'server',
    streaming: true,
    languages: 'multilingual',
    knownModels: [],
  };
}

function resolveTransportDescriptor(id: string): TransportProviderCapabilities {
  return {
    id,
    kind: 'transport',
    displayName: id,
    credentialSchema: [
      { field: 'url', required: true },
      { field: 'apiKey', required: true },
      { field: 'apiSecret', required: true },
    ],
    hosting: 'cloud',
    realtime: true,
    modes: ['pushToTalk', 'continuous'],
  };
}

function fakeTtsProvider(descriptor: TTSProviderCatalogEntry): TTSProvider {
  return {
    capabilities: descriptor,
    mapDeliveryTone() {
      return {};
    },
    applyDeliveryToText(text) {
      return text;
    },
    async *synthesizeStream() {
      yield new Uint8Array([0, 0]);
    },
    usage() {
      return [];
    },
  };
}

function fakeSttProvider(descriptor: STTProviderCatalogEntry): STTProvider {
  return {
    capabilities: descriptor,
    connect() {},
    sendAudio() {},
    async finalize() {
      return { text: '', final: true };
    },
    usage() {
      return [];
    },
    disconnect() {},
  };
}

export function fakeTransportRegistration(id: string): TransportProviderRegistration {
  const descriptor = resolveTransportDescriptor(id);
  return {
    descriptor,
    create(credentials, voiceSlice): TransportProvider {
      return {
        async mintSession(args) {
          const sessionId =
            args.sessionId ?? `${id}:${args.voiceName}:${args.userId ?? 'anonymous'}`;
          const url = credentials.url ?? `wss://${id}.example.test`;
          const room = args.roomName ?? sessionId;
          const identity = args.identity ?? args.userId ?? 'voice-user';
          const serializedMetadata =
            args.metadata === undefined ? undefined : JSON.stringify(args.metadata);
          const token = fakeRoomParticipantToken({
            room,
            identity,
            ttlSeconds: args.tokenTtlSeconds,
            metadata: serializedMetadata,
            attributes: args.attributes,
            agentName: args.voiceName,
            agentMetadata: serializedMetadata,
          });
          const audioTrackName =
            typeof voiceSlice.options?.agentAudioTrackName === 'string'
              ? voiceSlice.options.agentAudioTrackName
              : 'agent-voice';

          return {
            sessionId,
            transport: id,
            metadata: {
              url,
              room,
              token,
              identity,
              audioFormat: voiceSlice.audioFormat ?? 'pcm16;rate=16000;channels=1',
              audioTrackName,
              mode: voiceSlice.mode ?? 'continuous',
            },
          };
        },
      };
    },
    toClientSessionPayload(session) {
      const metadata = session.metadata ?? {};
      const audioTrackName =
        typeof metadata.audioTrackName === 'string' ? metadata.audioTrackName : undefined;
      return {
        transport: id,
        url: metadata.url,
        token: metadata.token,
        room: metadata.room,
        identity: metadata.identity,
        audioTrackName,
        agentAudioTrackName: audioTrackName,
        audioFormat: metadata.audioFormat,
        mode: metadata.mode,
        sessionId: session.sessionId,
      };
    },
  };
}

export function fakeTtsRegistration(
  id: string,
  descriptor?: TTSProviderCatalogEntry,
): TTSProviderRegistration {
  const resolved = resolveTtsDescriptor(id, descriptor);

  return {
    descriptor: resolved,
    create() {
      return fakeTtsProvider(resolved);
    },
    async listModels() {
      return [...resolved.knownModels];
    },
    async listVoices(credentials, modelId, context) {
      const baseUrl = credentials.baseUrl ?? `https://api.${id}.test`;
      const payload = await fetchCatalogJson(credentials, context.fetcher, `${baseUrl}/v1/voices`);
      return normalizeVoiceList(payload, { modelId });
    },
  };
}

export function fakeSttRegistration(
  id: string,
  descriptor?: STTProviderCatalogEntry,
): STTProviderRegistration {
  const resolved = resolveSttDescriptor(id, descriptor);
  return {
    descriptor: resolved,
    create() {
      return fakeSttProvider(resolved);
    },
    async listModels() {
      return [...resolved.knownModels];
    },
  };
}
