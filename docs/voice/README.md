# Voice (`@plumbus/voice`)

The Plumbus framework's voice primitive. It turns a declarative `defineVoice({...})` config into a governed speech surface: session minting, websocket/live transport choice, STT/TTS provider abstraction, delivery-tone hooks, and shared AI cost tracking.

These docs are split in three:

- **Usage** (the files in this folder) — how to define, configure, test, and ship voice.
- **[Design](./design/)** — why the provider/runtime abstraction looks the way it does.
- **Agent instructions** — prescriptive guidance for coding agents. Lives at [`packages/voice/instructions/`](../../packages/voice/instructions/) and ships in the npm tarball.

## Usage docs

| Doc | Read when… |
|---|---|
| [defining-voices.md](./defining-voices.md) | You want to author a new `defineVoice` config or mount `registerVoiceRoutes()`. |
| [configuration.md](./configuration.md) | You need to load provider credentials, validate them, or expose catalog/admin routes. |
| [providers.md](./providers.md) | You're picking STT/TTS/transport stacks or adding a custom provider registration. |
| [transports.md](./transports.md) | You need to choose between raw WebSocket and LiveKit. |
| [noise-cancellation.md](./noise-cancellation.md) | You're configuring Krisp/RNNoise/DTLN on LiveKit or WebSocket transports. |
| [client-stt.md](./client-stt.md) | You're considering `web-speech` or other browser-side transcript relay. |
| [local-providers.md](./local-providers.md) | You want a self-hosted Whisper sidecar or browser-native TTS. |
| [cost-tracking.md](./cost-tracking.md) | You need STT/TTS/transport spend to land in the shared AI ledger. |
| [testing.md](./testing.md) | You're writing smoke, route, websocket, or e2e tests. |
| [livekit-continuous-voice.md](./livekit-continuous-voice.md) | You're wiring a continuous (always-listening) LiveKit voice stack. |
| [security.md](./security.md) | You're exposing voice routes on a real app and need the S1-S10 threat model. |
| [design/providers.md](./design/providers.md) | You need the capability model, tone mapping rules, or ElevenLabs dual-model behavior. |

## Design docs

| Doc | Why it exists |
|---|---|
| [design/providers.md](./design/providers.md) | Explains the provider abstraction, tone-mapping boundary, and why adapters stay narrow. |

## Agent instructions

Read these when you're an AI agent extending a Plumbus app that uses voice. They live in the package itself ([`packages/voice/instructions/`](../../packages/voice/instructions/)) so they're available in `node_modules/@plumbus/voice/instructions/`:

- [`instructions/framework.md`](../../packages/voice/instructions/framework.md)
- [`instructions/client-stt.md`](../../packages/voice/instructions/client-stt.md)
- [`instructions/local-providers.md`](../../packages/voice/instructions/local-providers.md)
- [`instructions/security.md`](../../packages/voice/instructions/security.md)
- [`instructions/defining-voices.md`](../../packages/voice/instructions/defining-voices.md)
- [`instructions/providers.md`](../../packages/voice/instructions/providers.md)
- [`instructions/cost-tracking.md`](../../packages/voice/instructions/cost-tracking.md)
- [`instructions/testing.md`](../../packages/voice/instructions/testing.md)
- [`instructions/extending.md`](../../packages/voice/instructions/extending.md)
- [`instructions/noise-cancellation.md`](../../packages/voice/instructions/noise-cancellation.md)

## SDK surface (selected exports)

Beyond `defineVoice`, `registerVoiceRoutes`, and `runVoiceTurn`, the barrel also exposes:

| Group | Exports | Notes |
|-------|---------|-------|
| Catalog | `listVoiceProviderCatalog`, `suggestVoiceStacks`, `BUILTIN_*_PROVIDERS`, `fetchVoiceProviderOptions` | Powers `GET /api/voice/stacks` and admin catalog routes |
| Provider factory | `createSTTProvider`, `createTTSProvider`, `createTransportProvider`, `createProviderRegistry`, `validateVoiceProviders`, `resolveVoiceProvidersFromEnv` | Credential validation + runtime wiring |
| LiveKit / worker | `startVoiceWorker`, `mintLiveKitParticipantToken`, `createVoiceAgentEntry`, `bootstrapVoiceAgentConfigsFromModule`, `PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV` | CLI `plumbus voice worker` and agent bootstrap |
| Noise cancellation | `parseNoiseCancellation`, `serializeNoiseCancellation`, `applyClientNoiseCancellation`, `createInboundAudioStream`, … | See [noise-cancellation.md](./noise-cancellation.md) |
| Cost | `recordVoiceCost`, `recordLiveKitTransportCost`, `summarizeVoiceTurnCosts`, `lookupVoicePricing`, `listVoicePricing` | Shared AI ledger helpers |
| Tone / text | `applyDeliveryToneToText`, `mapDeliveryToneForProvider`, `stripVoiceAssistantMarkers` | TTS delivery shaping |
| Subpath | `@plumbus/voice/worker` | Worker entry used by `plumbus voice worker` |

## When to reach for `@plumbus/voice`

| You want… | Reach for |
|---|---|
| Text-only AI work inside a normal capability | `ctx.ai.*` in `@plumbus/core` |
| A multi-turn text conversation with citations and policies | `@plumbus/chat` |
| **Speech input/output around an app-owned brain hook** | **`@plumbus/voice`** |
| Speech-to-speech agent autonomy that replaces your app logic | Not this package; keep business logic in Plumbus primitives and let voice be the I/O layer. |
