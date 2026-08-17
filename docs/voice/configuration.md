# Voice Configuration

`registerVoiceRoutes()` receives a `VoiceProvidersConfig` object. Its keys mirror provider ids and carry the credential/config material needed to instantiate those providers.

## Shape

```ts
const providers = {
  providers: {
    websocket: {},
    livekit: {
      url: process.env['LIVEKIT_URL'],
      apiKey: process.env['LIVEKIT_API_KEY'],
      apiSecret: process.env['LIVEKIT_API_SECRET'],
    },
    soniox: {
      apiKey: process.env['SONIOX_API_KEY'],
    },
    'openai-whisper': {
      apiKey: process.env['OPENAI_API_KEY'],
      baseUrl: process.env['OPENAI_BASE_URL'],
    },
    'openai-realtime': {
      apiKey: process.env['OPENAI_API_KEY'],
      baseUrl: process.env['OPENAI_BASE_URL'],
    },
    deepdub: {
      apiKey: process.env['DEEPDUB_API_KEY'],
      baseUrl: process.env['DEEPDUB_BASE_URL'],
    },
    openai: {
      apiKey: process.env['OPENAI_API_KEY'],
      baseUrl: process.env['OPENAI_BASE_URL'],
    },
    minimax: {
      apiKey: process.env['MINIMAX_API_KEY'],
      baseUrl: process.env['MINIMAX_BASE_URL'],
      // optional — required by some MiniMax account setups
      options: { groupId: process.env['MINIMAX_GROUP_ID'] },
    },
    elevenlabs: {
      apiKey: process.env['ELEVENLABS_API_KEY'],
      baseUrl: process.env['ELEVENLABS_BASE_URL'],
    },
    'web-speech': {},
    'browser-tts': {},
  },
} satisfies VoiceProvidersConfig;
```

## Credential summary

| Provider | Install | Required fields | Notes |
|---|---|---|---|
| `websocket` | built-in | none | raw app-owned websocket transport |
| `livekit` | `@plumbus/voice-livekit` | `url`, `apiKey`, `apiSecret` | separate secret from app auth |
| `soniox` | `@plumbus/voice-soniox` | `apiKey` | STT and/or TTS; optional STT `options.contextTerms` → Soniox `context.terms` |
| `openai-whisper` | `@plumbus/voice-openai` | `apiKey` | official `openai` SDK; use `baseUrl` / `OPENAI_BASE_URL` for OpenAI-compatible Whisper endpoints |
| `openai-realtime` | `@plumbus/voice-openai` | `apiKey` | STT-only Realtime transcription via SDK (`OpenAIRealtimeWS`); connection model defaults to `gpt-realtime` (`stt.options.realtimeConnectionModel`); transcription model is `stt.model`; not full speech-to-speech |
| `deepdub` | `@plumbus/voice-deepdub` | `apiKey` | streaming/server TTS |
| `openai` | `@plumbus/voice-openai` | `apiKey` | official `openai` SDK TTS; same `baseUrl` override for compatible speech endpoints |
| `minimax` | `@plumbus/voice-minimax` | `apiKey` | server TTS, richer tone mapping; optional `options.groupId` / `MINIMAX_GROUP_ID`; optional TTS options `textNormalization`, `forceCbr`, `voiceModify` |
| `elevenlabs` | `@plumbus/voice-elevenlabs` | `apiKey` | flash vs v3 via official SDK |
| `web-speech` | built-in | none | client STT |
| `browser-tts` | built-in | none | client TTS |

## Validation

Use `validateVoiceProviders({ voices, providers, registry })` to fail fast before serving traffic. Pass the same `registry` you built with explicit `*_REGISTRATION` entries so missing add-ons are reported as issues with `field: 'package'`. Without `registry`, validation only checks credential shape against the static catalog.

## Catalog/admin routes

`registerVoiceRoutes()` also mounts admin-only discovery routes:

- `GET /api/voice/catalog`
- `GET /api/voice/catalog/:kind/:providerId/options`
- `GET /api/voice/stacks`

These are meant for internal/admin tooling such as voice setup screens and should never be anonymous.

## App configuration guidance

- keep provider secrets in server-side config only
- provide `sessionTokenSecret` separately from vendor credentials
- set `websocketOriginAllowlist` explicitly in production
- if you run behind a proxy, configure `trustProxy` on the core server so IP-based policies remain meaningful

## Reusing core OpenAI credentials

When STT/TTS providers are OpenAI-backed, bridge from your existing Plumbus bootstrap config instead of duplicating keys:

```ts
import { resolveVoiceOpenAICredentials } from '@plumbus/voice-openai';

const openai = resolveVoiceOpenAICredentials(plumbusConfig);
const providers = {
  providers: {
    openai,
    'openai-whisper': openai,
    'openai-realtime': openai,
  },
};
```

### Soniox STT context terms

For domain vocabulary (product names, Hebrew proper nouns), pass `contextTerms` on the voice STT slice:

```ts
stt: {
  provider: 'soniox',
  model: 'stt-rt-v5',
  languages: ['he'],
  options: {
    contextTerms: ['AcmeApp', 'ProductName'],
    enableEndpointDetection: true,
    maxEndpointDelayMs: 3000,
  },
},
```

The Soniox adapter maps this to `context.terms` in the realtime websocket config.
For raw PCM streams, it also sends `audio_format`, `sample_rate`, and `num_channels`
so Soniox can decode the forwarded LiveKit audio frames.

## Route options

`registerVoiceRoutes()` also accepts:

- `sessionBudget` / `sessionLifecycle` — per-session caps and idle/max-duration teardown
- `enableDebugEventStream` — admin-only SSE heartbeat at `GET /api/voice/:name/debug/events`
- `beforeSession` / `afterSession` — app hooks around session minting

## Voice clone routes

`registerVoiceCloneRoutes(app, routeConfig, opts)` is separate from `registerVoiceRoutes` (keeps Fastify optional). Register `@fastify/multipart` on the app before create / synthesize-reference uploads — missing multipart yields a clear dependency error.

Required opts: `access`, `resolveCloneOwner`, `afterCloneCreate`, `listOwnedClones`. Optional `referenceAccess` registers the Deepdub-style preview route. Deepdub session TTS with `tts.options.voiceReference` uses HTTP `generateToBuffer` wrapped as a **one-shot** async iterable (non-streaming for that utterance — not for manuscripts).

Full lifecycle, ownership, and spoofing guidance: [voice-cloning.md](./voice-cloning.md).

## Related docs

- [providers.md](./providers.md)
- [security.md](./security.md)
- [voice-cloning.md](./voice-cloning.md)
