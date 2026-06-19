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

| Provider | Required fields | Notes |
|---|---|---|
| `websocket` | none | raw app-owned websocket transport |
| `livekit` | `url`, `apiKey`, `apiSecret` | separate secret from app auth |
| `soniox` | `apiKey` | server STT; optional `options.contextTerms` maps to Soniox `context.terms` |
| `openai-whisper` | `apiKey` | use `baseUrl` for local/self-hosted compatible endpoints |
| `openai-realtime` | `apiKey` | STT-only transcription path, not full speech-to-speech |
| `deepdub` | `apiKey` | streaming/server TTS |
| `openai` | `apiKey` | server TTS |
| `minimax` | `apiKey` | server TTS, richer tone mapping |
| `elevenlabs` | `apiKey` | flash vs v3 tradeoffs differ by model |
| `web-speech` | none | client STT |
| `browser-tts` | none | client TTS |

## Validation

Use `validateVoiceProviders({ voices, providers })` to fail fast before serving traffic. `registerVoiceRoutes()` also validates on mount and throws if the chosen voice stacks are missing required credential fields.

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
import { resolveVoiceOpenAICredentials } from '@plumbus/voice';

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

## Related docs

- [providers.md](./providers.md)
- [security.md](./security.md)
