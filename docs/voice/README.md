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
| [voice-cloning.md](./voice-cloning.md) | Persisted voice clones, ownership-aware HTTP routes, Deepdub preview vs long-form TTS. |
| [design/providers.md](./design/providers.md) | You need the capability model, tone mapping rules, or ElevenLabs dual-model behavior. |
| [../upgrading-voice-provider-packages.md](../upgrading-voice-provider-packages.md) | You're moving from `@plumbus/voice` 0.3.x to 0.4.x provider add-on packages. |

## Provider add-on packages

`@plumbus/voice` ships builtins only: `websocket`, `web-speech`, and `browser-tts`. Cloud/vendor providers (including OpenAI) are separate packages — install them and pass their `*_REGISTRATION` into `createProviderRegistry()`. CLI/workers load `app/voice/registry.ts` (`voiceProviderRegistry`); there is no `createRegistryForVoices` / `VOICE_ADDON_PACKAGES` auto-load.

| Provider id | Package | Open after install (consumer app) |
|---|---|---|
| `openai-whisper` / `openai-realtime` / `openai` | `@plumbus/voice-openai` | `node_modules/@plumbus/voice-openai/instructions/README.md` |
| `livekit` | `@plumbus/voice-livekit` | `node_modules/@plumbus/voice-livekit/instructions/README.md` |
| `soniox` | `@plumbus/voice-soniox` | `node_modules/@plumbus/voice-soniox/instructions/README.md` |
| `deepdub` | `@plumbus/voice-deepdub` | `node_modules/@plumbus/voice-deepdub/instructions/README.md` |
| `elevenlabs` | `@plumbus/voice-elevenlabs` | `node_modules/@plumbus/voice-elevenlabs/instructions/README.md` |
| `minimax` | `@plumbus/voice-minimax` | `node_modules/@plumbus/voice-minimax/instructions/README.md` |

## Design docs

| Doc | Why it exists |
|---|---|
| [design/providers.md](./design/providers.md) | Explains the provider abstraction, tone-mapping boundary, and why adapters stay narrow. |

## Agent instructions

After `pnpm add @plumbus/voice`, open **`node_modules/@plumbus/voice/instructions/README.md` first**. That index lists every topic file and the exact `node_modules/@plumbus/voice-*/instructions/README.md` paths for provider add-ons. Run `plumbus init --patch` so project agent wiring (`AGENTS.md`, Copilot, Cursor) repeats those paths.

Monorepo source: [`packages/voice/instructions/`](../../packages/voice/instructions/).

## SDK surface (selected exports)

Beyond `defineVoice`, `registerVoiceRoutes`, and `runVoiceTurn`, the barrel also exposes:

| Group | Exports | Notes |
|-------|---------|-------|
| Catalog | `listVoiceProviderCatalog`, `suggestVoiceStacks`, `BUILTIN_*_PROVIDERS`, `fetchVoiceProviderOptions` | Powers `GET /api/voice/stacks` and admin catalog routes |
| Provider factory | `createSTTProvider`, `createTTSProvider`, `createTransportProvider`, `createProviderRegistry`, `validateVoiceProviders`, `resolveVoiceProvidersFromEnv`, `loadAppVoiceRegistry` | Credential validation + runtime wiring; CLI/workers load `app/voice/registry.ts` |
| LiveKit / worker | — | Import from `@plumbus/voice-livekit` (`startVoiceAgentWorker`, `joinVoiceRoomSession`, `createVoiceAgentEntry`, …) or `@plumbus/voice-livekit/client` |
| Noise cancellation | `parseNoiseCancellation`, `serializeNoiseCancellation`, … | Browser client NC (`applyClientNoiseCancellation`) and agent inbound stream helpers live on `@plumbus/voice-livekit` |
| OpenAI STT/TTS | — | Import registrations from `@plumbus/voice-openai` (`OPENAI_WHISPER_STT_REGISTRATION`, `OPENAI_REALTIME_STT_REGISTRATION`, `OPENAI_TTS_REGISTRATION`) |
| Provider kit | `@plumbus/voice/provider-kit` | Shared types/helpers for authoring `@plumbus/voice-*` add-ons |
| Cost | `recordVoiceCost`, `summarizeVoiceTurnCosts`, `lookupVoicePricing`, `listVoicePricing` | Shared AI ledger helpers (`recordLiveKitTransportCost` lives on `@plumbus/voice-livekit`) |
| Tone / text | `applyDeliveryToneToText`, `mapDeliveryToneForProvider`, `stripVoiceAssistantMarkers` | TTS delivery shaping |
| Subpath | `@plumbus/voice/worker` | Discover / env / execution-context helpers (LiveKit worker APIs are on the livekit add-on) |

## When to reach for `@plumbus/voice`

| You want… | Reach for |
|---|---|
| Text-only AI work inside a normal capability | `ctx.ai.*` in `@plumbus/core` |
| A multi-turn text conversation with citations and policies | `@plumbus/chat` |
| **Speech input/output around an app-owned brain hook** | **`@plumbus/voice`** |
| Speech-to-speech agent autonomy that replaces your app logic | Not this package; keep business logic in Plumbus primitives and let voice be the I/O layer. |
