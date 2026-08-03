# @plumbus/voice

> **Real-time voice runtime for [Plumbus](https://github.com/plumbus-framework/plumbus) apps.** Define a voice once, pick a transport + STT + TTS stack, and mount governed session routes with shared cost tracking — your brain stays in normal Plumbus primitives.

[![npm](https://img.shields.io/npm/v/@plumbus/voice.svg)](https://www.npmjs.com/package/@plumbus/voice)
[![license](https://img.shields.io/npm/l/@plumbus/voice.svg)](./LICENSE)
[![peer: @plumbus/core 0.6.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.6.x-blue)](https://www.npmjs.com/package/@plumbus/core)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. You declare capabilities, entities, events, flows, prompts, and translations through `define*()` functions; the framework generates routes, validation, audit, security, and types.

`@plumbus/voice` adds a **voice primitive** on top of that contract — one `defineVoice({...})` declaration becomes a governed speech surface with:

- Session minting and access checks through core auth / deny-by-default policies
- Swappable transport / STT / TTS via an explicit provider registry
- Turn orchestration (`listen → brain → speak`) with delivery-tone hooks
- Cost rows into the shared AI ledger (`recordVoiceCost` → `onAICostRecorded`)
- Browser helpers for Web Speech (`@plumbus/voice/client`) and a testing harness (`@plumbus/voice/testing`)

If you're not using Plumbus, this package won't make sense in isolation — `defineVoice` composes on the framework's `ExecutionContext`, access policies, and cost pipeline. The **brain** is yours; voice is the I/O layer, not a speech-to-speech replacement for Plumbus primitives.

**Built-in providers only:** `websocket` (transport), `web-speech` (STT), `browser-tts` (TTS). Cloud vendors (OpenAI, LiveKit, Soniox, Deepdub, ElevenLabs, MiniMax, …) ship as separate `@plumbus/voice-*` packages.

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| One-shot text generation inside a normal capability | `ctx.ai.generate` in `@plumbus/core` |
| A multi-turn text chat UI | [`@plumbus/chat`](../chat/) + optionally [`@plumbus/chat-ui`](../chat-ui/) |
| Registry-backed grounding for a voice/chat surface | [`@plumbus/knowledge-base`](../knowledge-base/) |
| **Realtime speech input/output with an app-owned brain hook** | **`@plumbus/voice`** (this package) |
| LiveKit rooms / agent workers | [`@plumbus/voice-livekit`](../voice-livekit/) |
| OpenAI Whisper / Realtime STT or OpenAI TTS | [`@plumbus/voice-openai`](../voice-openai/) |
| Speech-to-speech agent autonomy that replaces your app logic | Not this package — keep business logic in Plumbus primitives |

## What you get

| Surface | What it does |
|---|---|
| `defineVoice({...})` | Validates and deep-freezes a voice definition (access, transport, STT, TTS, `brain`). |
| `registerVoiceRoutes(app, routeConfig, voices, opts)` | Mounts session, health, catalog, websocket, and transport-agnostic `/token` routes. |
| `runVoiceTurn(ctx, args)` | In-process turn runner used by transports and tests. |
| `createProviderRegistry({ stt?, tts?, transport? })` | Compose built-ins with explicit `*_REGISTRATION` from add-on packages. **No auto-load.** |
| `validateVoiceProviders()` | Credential-shape + registration coverage for the selected stack. |
| `listVoiceProviderCatalog()` / `suggestVoiceStacks()` / `fetchVoiceProviderOptions()` | Static catalog + optional live model/voice discovery. |
| `resolveVoiceProvidersFromEnv()` | Built-in credential shapes from env (websocket / web-speech / browser-tts). |
| `loadAppVoiceRegistry()` | Loads `app/voice/registry.ts` for CLI / workers (`voiceProviderRegistry` + optional `voiceProviders`). |
| `recordVoiceCost()` / `createVoiceSessionBudget()` | Shared cost ledger + session budget helper. |
| `@plumbus/voice/client` | Browser Web Speech wrappers (`createWebSpeechRecognizer`, `createBrowserSpeechSynthesizer`). |
| `@plumbus/voice/noise-cancellation` | Thin browser-safe NC enums/types (for `@plumbus/voice-livekit/client` and custom UIs). |
| `@plumbus/voice/provider-kit` | Types and helpers for authoring `@plumbus/voice-*` add-on packages. |
| `@plumbus/voice/testing` | Mock providers, runtime harness, fixtures. |

## Status

Optional add-on of `@plumbus/core` (version-locked `0.6.x`). Ships `defineVoice`, `registerVoiceRoutes`, the provider registry, built-in websocket / web-speech / browser-tts adapters, cost helpers, client Web Speech wrappers, and the testing surface. Cloud/vendor adapters are **not** bundled — install `@plumbus/voice-*` and register each `*_REGISTRATION` explicitly.

## Install

```bash
pnpm add @plumbus/voice
# plus any optional provider add-ons you actually use
```

Required peer: `@plumbus/core` `0.6.x` (copy the literal from `package.json` — do not invent caret ranges). `@plumbus/voice` does **not** peer-depend on the `@plumbus/voice-*` add-ons.

### Optional provider add-ons

Install only what you use, then pass each package's `*_REGISTRATION` into `createProviderRegistry()` and pass that registry to routes/workers. **Install alone does not register.**

```bash
pnpm add @plumbus/voice-openai     # openai-whisper / openai-realtime STT + openai TTS
pnpm add @plumbus/voice-livekit    # livekit transport + agent worker + browser session
pnpm add @plumbus/voice-soniox     # soniox STT + TTS
pnpm add @plumbus/voice-deepdub    # deepdub TTS
pnpm add @plumbus/voice-elevenlabs # elevenlabs TTS
pnpm add @plumbus/voice-minimax    # minimax TTS
```

| Provider id | Kind | Package |
|---|---|---|
| `websocket` | transport | built-in |
| `web-speech` | STT | built-in |
| `browser-tts` | TTS | built-in |
| `openai-whisper` / `openai-realtime` / `openai` | STT / TTS | [`@plumbus/voice-openai`](../voice-openai/) |
| `livekit` | transport | [`@plumbus/voice-livekit`](../voice-livekit/) |
| `soniox` | STT + TTS | [`@plumbus/voice-soniox`](../voice-soniox/) |
| `deepdub` | TTS | [`@plumbus/voice-deepdub`](../voice-deepdub/) |
| `elevenlabs` | TTS | [`@plumbus/voice-elevenlabs`](../voice-elevenlabs/) |
| `minimax` | TTS | [`@plumbus/voice-minimax`](../voice-minimax/) |

## Quick start

Built-ins only (zero cloud keys) — good for local browser prototypes:

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

onRoutesRegistered((app, routeConfig) => {
  registerVoiceRoutes(app, routeConfig, [interviewVoice], {
    providers: {
      providers: {
        websocket: {},
        'web-speech': {},
        'browser-tts': {},
      },
    },
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
    websocketOriginAllowlist: ['https://app.example.com'],
  });
});
```

With add-ons — **explicit registration** (no auto-load):

```ts
import { createProviderRegistry, defineVoice, registerVoiceRoutes } from '@plumbus/voice';
import { OPENAI_TTS_REGISTRATION, OPENAI_WHISPER_STT_REGISTRATION } from '@plumbus/voice-openai';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '@plumbus/voice-livekit';
import { onRoutesRegistered } from '@plumbus/core';

export const voiceProviderRegistry = createProviderRegistry({
  stt: { 'openai-whisper': OPENAI_WHISPER_STT_REGISTRATION },
  tts: { openai: OPENAI_TTS_REGISTRATION },
  transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  access: { roles: ['user'] },
  transport: { provider: 'livekit', mode: 'continuous' },
  stt: { provider: 'openai-whisper', model: 'whisper-1', languages: ['en'] },
  tts: { provider: 'openai', model: 'tts-1', voiceId: 'alloy' },
  brain: {
    async run(ctx, args) {
      // app logic via ctx.* / capabilities
      return { text: args.transcript ?? '' };
    },
  },
});

onRoutesRegistered((app, routeConfig) => {
  registerVoiceRoutes(app, routeConfig, [supportVoice], {
    registry: voiceProviderRegistry,
    providers: {
      providers: {
        livekit: {
          url: process.env['LIVEKIT_URL'],
          apiKey: process.env['LIVEKIT_API_KEY'],
          apiSecret: process.env['LIVEKIT_API_SECRET'],
        },
        'openai-whisper': { apiKey: process.env['OPENAI_API_KEY'] },
        openai: { apiKey: process.env['OPENAI_API_KEY'] },
      },
    },
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
  });
});
```

### CLI / workers: `app/voice/registry.ts`

`plumbus voice worker` (and other CLI voice paths) load the app registry from disk. Export `voiceProviderRegistry` from `createProviderRegistry({ ...*_REGISTRATION })`. Optionally export `voiceProviders` for credentials:

```ts
// app/voice/registry.ts
import { createProviderRegistry } from '@plumbus/voice';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '@plumbus/voice-livekit';
import { OPENAI_TTS_REGISTRATION, OPENAI_WHISPER_STT_REGISTRATION } from '@plumbus/voice-openai';

export const voiceProviderRegistry = createProviderRegistry({
  stt: { 'openai-whisper': OPENAI_WHISPER_STT_REGISTRATION },
  tts: { openai: OPENAI_TTS_REGISTRATION },
  transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
});

export const voiceProviders = {
  providers: {
    livekit: {
      url: process.env['LIVEKIT_URL'],
      apiKey: process.env['LIVEKIT_API_KEY'],
      apiSecret: process.env['LIVEKIT_API_SECRET'],
    },
    'openai-whisper': { apiKey: process.env['OPENAI_API_KEY'] },
    openai: { apiKey: process.env['OPENAI_API_KEY'] },
  },
};
```

There is no `createRegistryForVoices`, no `VOICE_ADDON_PACKAGES` soft-load, and no auto-discovery of installed add-ons.

## Key gotchas

- **Built-ins only cover browser/local prototypes.** Anything OpenAI / LiveKit / Soniox / Deepdub / ElevenLabs / MiniMax requires the matching add-on **and** `*_REGISTRATION` in `createProviderRegistry()`.
- **Install alone does nothing.** Missing registration fails with `voice.provider_package_missing` (+ `metadata.installPackage`) — fix by registering, never by inventing a local adapter.
- **CLI/workers need `app/voice/registry.ts`.** Export `voiceProviderRegistry` (alias `registry` also accepted). Optional `voiceProviders` / `providers` for credentials.
- **`web-speech` is client STT.** Treat transcripts as untrusted `source: 'client-stt'` input — same guards as typed user text. See [`docs/voice/client-stt.md`](../../docs/voice/client-stt.md).
- **LiveKit APIs moved.** `createLiveKitVoiceSession` / `applyClientNoiseCancellation` → `@plumbus/voice-livekit/client`; worker helpers → `@plumbus/voice-livekit`. `/token` is transport-agnostic (`beforeSession.room`).
- **Migration playbook:** [`docs/upgrading-voice-provider-packages.md`](../../docs/upgrading-voice-provider-packages.md).

## Documentation

- **Concept docs** (in the monorepo): [`docs/voice/`](../../docs/voice/)
  - [`README.md`](../../docs/voice/README.md) — landing page, reading order, package boundaries
  - [`defining-voices.md`](../../docs/voice/defining-voices.md) — `defineVoice`, routes, worker wiring
  - [`configuration.md`](../../docs/voice/configuration.md) — credential shapes, config loading, catalog endpoints
  - [`providers.md`](../../docs/voice/providers.md) — built-ins, provider add-ons, catalog API, custom registration
  - [`upgrading-voice-provider-packages.md`](../../docs/upgrading-voice-provider-packages.md) — 0.3.x → 0.4.x provider add-on migration
  - [`transports.md`](../../docs/voice/transports.md) — LiveKit vs raw WebSocket
  - [`livekit-continuous-voice.md`](../../docs/voice/livekit-continuous-voice.md) — continuous LiveKit voice stacks
  - [`client-stt.md`](../../docs/voice/client-stt.md) — Web Speech trust boundary + wire protocol
  - [`local-providers.md`](../../docs/voice/local-providers.md) — Whisper sidecars and browser TTS
  - [`cost-tracking.md`](../../docs/voice/cost-tracking.md) — cost rows, rollups, `cost: null`
  - [`testing.md`](../../docs/voice/testing.md) — smoke tiers, test helpers, e2e patterns
  - [`security.md`](../../docs/voice/security.md) — S1-S10 threat model
  - [`design/providers.md`](../../docs/voice/design/providers.md) — provider abstraction rationale, tone mapping
- **Agent recipes** — after install, open `node_modules/@plumbus/voice/instructions/README.md` first (index + add-on path table). Topic files:
  - `node_modules/@plumbus/voice/instructions/framework.md`
  - `node_modules/@plumbus/voice/instructions/client-stt.md`
  - `node_modules/@plumbus/voice/instructions/local-providers.md`
  - `node_modules/@plumbus/voice/instructions/security.md`
  - `node_modules/@plumbus/voice/instructions/defining-voices.md`
  - `node_modules/@plumbus/voice/instructions/providers.md`
  - `node_modules/@plumbus/voice/instructions/cost-tracking.md`
  - `node_modules/@plumbus/voice/instructions/testing.md`
  - `node_modules/@plumbus/voice/instructions/extending.md`
  - `node_modules/@plumbus/voice/instructions/noise-cancellation.md`
- **Provider add-on indexes** (open after installing each package):
  - `node_modules/@plumbus/voice-openai/instructions/README.md`
  - `node_modules/@plumbus/voice-livekit/instructions/README.md`
  - `node_modules/@plumbus/voice-soniox/instructions/README.md`
  - `node_modules/@plumbus/voice-deepdub/instructions/README.md`
  - `node_modules/@plumbus/voice-elevenlabs/instructions/README.md`
  - `node_modules/@plumbus/voice-minimax/instructions/README.md`
- Run `plumbus init --patch` so `AGENTS.md` / Copilot wiring lists these same paths.

## The Plumbus ecosystem

`@plumbus/voice` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## Testing

```bash
pnpm --filter @plumbus/voice test
pnpm --filter @plumbus/voice typecheck
pnpm --filter @plumbus/voice smoke
```

For consumer-app tests, import `mockVoiceRuntime`, `createVoiceTestContext`, and the mock providers from `@plumbus/voice/testing`. See [`docs/voice/testing.md`](../../docs/voice/testing.md).

## License

MIT
