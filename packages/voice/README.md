# @plumbus/voice

> **Real-time voice runtime for Plumbus apps.** Define a voice once, pick a transport + STT + TTS stack, and mount governed session routes with shared cost tracking.

## What is this?

[`Plumbus`](https://github.com/plumbus-framework/plumbus) is an AI-native, contract-driven TypeScript framework. `@plumbus/voice` is an **optional add-on** that adds a seventh primitive — **Voice** — alongside capabilities, entities, flows, events, prompts, and translations.

A **voice** is a governed speech surface: you declare it once with `defineVoice()`, wire your app logic into a `brain` hook, pick how audio moves (transport) and which STT/TTS vendors to use, then mount session routes with `registerVoiceRoutes()`. The runtime handles session tokens, websocket/LiveKit wiring, provider adapters, turn orchestration, delivery tone, and cost rows — your code stays in normal Plumbus patterns (`ctx.*`, capabilities, flows, `ctx.ai`).

**What you get**

| Piece | Role |
|---|---|
| `defineVoice({...})` | Contract for one voice: access policy, transport, STT, TTS, and `brain.run(ctx, args)` |
| `registerVoiceRoutes()` | HTTP session minting, health/catalog routes, WebSocket or LiveKit bootstrap |
| Provider registry | Swappable STT, TTS, and transport adapters with credential validation |
| `runVoiceTurn()` | Single-turn pipeline (listen → brain → speak) for tests and in-process use |
| Cost integration | STT/TTS/transport spend via `recordVoiceCost` → shared `onAICostRecorded` ledger |
| `@plumbus/voice/client` | Browser helpers (LiveKit session, Web Speech wrappers) |
| `plumbus voice worker` | LiveKit agent worker CLI for continuous / room-based deployments |

**What this is not**

- Not a speech-to-speech agent that replaces your app — the **brain** is yours; voice is the I/O layer.
- Not a replacement for `@plumbus/chat` — text chat and voice complement each other.
- Not required — apps without speech never install it.

## Architecture

Voice splits **media plumbing** from **app logic**. You own the brain; the package owns how audio and transcripts move through STT/TTS providers and how sessions are secured.

```
  Browser / client                    Your Plumbus server
 ┌─────────────────┐               ┌──────────────────────────────────────┐
 │  mic / speaker  │               │  registerVoiceRoutes()               │
 │  (optional      │  transport    │    ├─ session token + auth (core)    │
 │   client STT)   │◄─────────────►│    ├─ Transport (websocket/livekit)│
 └─────────────────┘               │    ├─ STT  → transcript              │
                                   │    ├─ brain.run(ctx)  ← your logic  │
                                   │    └─ TTS  → audio out              │
                                   │         ↓                          │
                                   │  ctx.ai.recordProviderCost (core)  │
                                   └──────────────────────────────────────┘
```

**Layers in a voice definition**

| Layer | Config | Responsibility |
|---|---|---|
| **Transport** | `transport.provider` | Session setup and audio/data frames (`websocket` or `livekit`; push-to-talk or continuous) |
| **STT** | `stt.provider` | Speech → text on the server (`soniox`, `openai-whisper`, …) or in the browser (`web-speech`) |
| **Brain** | `brain.run(ctx, args)` | Your hook — call `ctx.ai`, capabilities, RAG, DB; return text (or stream deltas) for TTS |
| **TTS** | `tts.provider` | Text → audio on the server (`deepdub`, `openai`, …) or in the browser (`browser-tts`) |
| **Access** | `access` | Deny-by-default policy evaluated by core before a session or turn runs |

**One turn (simplified)**

1. Client opens a session (HTTP) and connects on the chosen transport.
2. User speaks → STT produces a transcript (or the browser sends one for `web-speech`).
3. Runtime calls `brain.run(ctx, { transcript, sessionId, input, onAssistantDelta })`.
4. Assistant text is chunked and synthesized through TTS; audio streams back on the transport.
5. STT/TTS/transport usage is recorded to the shared AI cost ledger when configured.

**How it sits on `@plumbus/core`**

| Concern | Owner |
|---|---|
| Auth, access policies, `ExecutionContext` | `@plumbus/core` |
| Business logic | Your `brain` hook (capabilities, `ctx.ai`, entities, flows) |
| Session routes, providers, turn pipeline | `@plumbus/voice` |
| Cost ledger hook | `@plumbus/core` (`onAICostRecorded`); voice writes media rows into it |

For continuous LiveKit deployments, a separate **voice worker** (`plumbus voice worker`) joins rooms as the agent process while still calling your bootstrap module for voices, providers, and `createDependencies`. See [`docs/voice/livekit-continuous-voice.md`](../../docs/voice/livekit-continuous-voice.md).

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| One-shot text generation inside a normal capability | `ctx.ai.generate` in `@plumbus/core` |
| A multi-turn text chat UI | [`@plumbus/chat`](../chat/) + optionally [`@plumbus/chat-ui`](../chat-ui/) |
| Registry-backed grounding for a voice/chat surface | [`@plumbus/knowledge-base`](../knowledge-base/) |
| **Realtime speech input/output with push-to-talk transport** | **`@plumbus/voice`** (this package) |

## Supported providers

Every voice picks one **transport** (how audio moves), one **STT** provider (speech → text), and one **TTS** provider (text → speech). The **Config id** is the value you use in `defineVoice({ transport/stt/tts: { provider: '<id>' } })` and as the key in `VoiceProvidersConfig`.

### Transports (audio connection)

| Provider | Config id | Hosting | Modes | Credentials |
|---|---|---|---|---|
| LiveKit | `livekit` | Cloud | push-to-talk, continuous | `url`, `apiKey`, `apiSecret` |
| WebSocket | `websocket` | Self-hosted | push-to-talk, continuous | none |

### Speech-to-Text — STT (listening)

| Provider | Config id | Runs on | Streaming | Credentials | Notes |
|---|---|---|---|---|---|
| Soniox | `soniox` | Server (cloud) | Yes | `apiKey` | Multilingual, live endpoint detection — reference production STT |
| OpenAI Realtime | `openai-realtime` | Server (cloud) | Yes | `apiKey` | Multilingual, low-latency streaming |
| OpenAI Whisper | `openai-whisper` | Server (cloud) | No (batch) | `apiKey` | Multilingual; set `baseUrl` to point at a self-hosted Whisper-compatible sidecar |
| Web Speech | `web-speech` | Browser (client) | Yes | none | Browser does STT and relays the transcript — treat as untrusted client input (see Client-side STT) |

### Text-to-Speech — TTS (speaking)

| Provider | Config id | Runs on | Streaming | Credentials | Notes |
|---|---|---|---|---|---|
| Deepdub | `deepdub` | Server (cloud) | Yes | `apiKey` | Full delivery tone (pace/warmth/energy/emotion) |
| MiniMax | `minimax` | Server (cloud) | Yes | `apiKey` | Full delivery tone, language boost |
| ElevenLabs | `elevenlabs` | Server (cloud) | Yes (Flash) / No (v3) | `apiKey` | Partial delivery tone; `eleven_v3` uses inline text tags |
| OpenAI TTS | `openai` | Server (cloud) | Yes | `apiKey` | Pace-only tone; built-in voices (alloy, echo, fable, onyx, nova, shimmer) |
| Browser TTS | `browser-tts` | Browser (client) | No | none | Client-side synthesis, zero server credentials, not billable |

> Need a provider that isn't listed? Register your own with `createProviderRegistry()` — see [`instructions/extending.md`](./instructions/extending.md).

### Ready-made stacks

Convenient transport + STT + TTS combinations (from `suggestVoiceStacks()`):

| Use case | Transport | STT | TTS |
|---|---|---|---|
| LiveKit production | `livekit` | `soniox` | `deepdub` |
| MiniMax evaluation | `websocket` | `openai-whisper` | `minimax` |
| Local dev (no LiveKit) | `websocket` | `openai-realtime` | `openai` |
| Browser dev, zero STT keys | `websocket` | `web-speech` | `openai` |
| Offline batch evaluation | `websocket` | `openai-whisper` | `openai` |
| Fully local / zero-cloud | `websocket` | `web-speech` | `browser-tts` |

## Install

```bash
pnpm add @plumbus/voice
```

Required peer: `@plumbus/core` `0.6.x` (see `package.json` `peerDependencies` — copy the literal; do not invent caret ranges).

## Quick start

```ts
import { defineVoice, registerVoiceRoutes } from '@plumbus/voice';
import { onRoutesRegistered } from '@plumbus/core';

export const interviewVoice = defineVoice({
  name: 'interview',
  access: { roles: ['subject'] },
  transport: { provider: 'websocket', mode: 'pushToTalk' },
  stt: { provider: 'web-speech', languages: ['en-US'] },
  tts: { provider: 'browser-tts', locale: 'en-US', voiceId: 'default' },
  brain: {
    async run(_ctx, args) {
      return { text: `I heard: ${args.transcript ?? ''}` };
    },
  },
});

const providers = {
  providers: {
    websocket: {},
    'web-speech': {},
    'browser-tts': {},
  },
};

onRoutesRegistered((app, routeConfig) => {
  registerVoiceRoutes(app, routeConfig, [interviewVoice], {
    providers,
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
    websocketOriginAllowlist: ['https://app.example.com'],
  });
});
```

## Provider configuration

`registerVoiceRoutes()` expects a `VoiceProvidersConfig` object. The keys mirror provider ids:

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
    deepdub: {
      apiKey: process.env['DEEPDUB_API_KEY'],
      baseUrl: process.env['DEEPDUB_BASE_URL'],
    },
  },
} satisfies VoiceProvidersConfig;
```

Use `validateVoiceProviders({ voices, providers })` at boot or let `registerVoiceRoutes()` fail fast when required credential fields are missing.

## Client-side STT: `web-speech`

`web-speech` means the browser performs STT and relays the final transcript to the server over the voice event protocol. That changes the trust boundary:

- treat transcript text as `source: 'client-stt'`
- never bill or trust it as authoritative speech evidence
- apply the same content guards you would apply to typed user input
- prefer server STT for production billing, retention, or audit-heavy use cases

Use `web-speech` when you need the cheapest browser-first setup and can accept varying browser support. See [`docs/voice/client-stt.md`](../../docs/voice/client-stt.md) and [`instructions/client-stt.md`](./instructions/client-stt.md).

## Local STT / TTS

Two built-in low-friction local paths:

- **`openai-whisper` + `baseUrl`** for a self-hosted Whisper-compatible sidecar
- **`browser-tts`** for client-side speech synthesis with no server credentials

Do not invent a new adapter just to point at a Whisper-compatible local endpoint. Start with `openai-whisper` and override `baseUrl`. See [`docs/voice/local-providers.md`](../../docs/voice/local-providers.md).

## What's included

| Surface | What it does |
|---|---|
| `defineVoice({...})` | Validates and deep-freezes a voice definition. |
| `registerVoiceRoutes(app, routeConfig, voices, opts)` | Mounts session, health, catalog, and websocket routes. |
| `runVoiceTurn(ctx, args)` | In-process turn runner used by transports and tests. |
| `listVoiceProviderCatalog()` / `fetchVoiceProviderOptions()` | Static catalog + optional live model/voice discovery. |
| `validateVoiceProviders()` | Credential-shape validation by selected transport/STT/TTS stack. |
| `resolveVoiceOpenAICredentials(config)` | Bridge `PlumbusConfig.aiProviders.openai` into voice OpenAI adapters. |
| `createProviderRegistry()` | Extend or replace built-in provider registrations. |
| `recordVoiceCost()` / `createVoiceSessionBudget()` | Shared cost ledger + session budget helper. |
| `ctx.ai.checkProviderCostBudget()` | Pre-turn shared daily USD cap check (via core `@plumbus/core@0.6`). |
| `@plumbus/voice/client` | Browser-side helpers and types (`createLiveKitVoiceSession`, Web Speech wrappers). |
| `@plumbus/voice/testing` | Mock providers, runtime harness, fixtures. |

## Documentation

- **Concept docs** (in the monorepo): [`docs/voice/`](../../docs/voice/)
  - [`README.md`](../../docs/voice/README.md) — landing page, reading order, package boundaries
  - [`defining-voices.md`](../../docs/voice/defining-voices.md) — `defineVoice`, routes, worker wiring
  - [`configuration.md`](../../docs/voice/configuration.md) — credential shapes, config loading, catalog endpoints
  - [`providers.md`](../../docs/voice/providers.md) — built-ins, catalog API, custom registration
  - [`transports.md`](../../docs/voice/transports.md) — LiveKit vs raw WebSocket
  - [`livekit-continuous-voice.md`](../../docs/voice/livekit-continuous-voice.md) — continuous (always-listening) LiveKit voice stacks
  - [`client-stt.md`](../../docs/voice/client-stt.md) — Web Speech trust boundary + wire protocol
  - [`local-providers.md`](../../docs/voice/local-providers.md) — Whisper sidecars and browser TTS
  - [`cost-tracking.md`](../../docs/voice/cost-tracking.md) — cost rows, rollups, `cost: null`
  - [`testing.md`](../../docs/voice/testing.md) — smoke tiers, test helpers, e2e patterns
  - [`security.md`](../../docs/voice/security.md) — S1-S10 threat model
  - [`design/providers.md`](../../docs/voice/design/providers.md) — provider abstraction rationale, tone mapping
- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/voice/instructions/`):
  - [`instructions/framework.md`](./instructions/framework.md) — package boundary, file map, critical rules
  - [`instructions/client-stt.md`](./instructions/client-stt.md) — wire `web-speech` correctly
  - [`instructions/local-providers.md`](./instructions/local-providers.md) — local/offline voice stack guidance
  - [`instructions/security.md`](./instructions/security.md) — session token and secret-handling rules
  - [`instructions/defining-voices.md`](./instructions/defining-voices.md) — recipe for adding a voice
  - [`instructions/providers.md`](./instructions/providers.md) — provider picker
  - [`instructions/cost-tracking.md`](./instructions/cost-tracking.md) — voice cost tagging
  - [`instructions/testing.md`](./instructions/testing.md) — smoke/e2e test patterns
  - [`instructions/extending.md`](./instructions/extending.md) — tone hooks, custom providers, runtime extension points

## The Plumbus ecosystem

`@plumbus/voice` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Testing

```bash
pnpm --filter @plumbus/voice test
pnpm --filter @plumbus/voice typecheck
pnpm --filter @plumbus/voice smoke
```

For consumer-app tests, import `mockVoiceRuntime`, `createVoiceTestContext`, and the mock providers from `@plumbus/voice/testing`. See [`docs/voice/testing.md`](../../docs/voice/testing.md).

Manual pre-release audio check:

```bash
pnpm --filter @plumbus/voice exec tsx scripts/quality-harness.ts /path/to/input.wav
```

## License

MIT
