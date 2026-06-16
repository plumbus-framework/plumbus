# @plumbus/voice

> **Real-time voice runtime for Plumbus apps.** Define a voice once, pick a transport + STT + TTS stack, and mount governed session routes with shared cost tracking.

[![npm](https://img.shields.io/npm/v/@plumbus/voice.svg)](https://www.npmjs.com/package/@plumbus/voice)
[![license](https://img.shields.io/npm/l/@plumbus/voice.svg)](./LICENSE)
[![peer: @plumbus/core ^0.6](https://img.shields.io/badge/peer-%40plumbus%2Fcore%20%5E0.6-blue)](https://www.npmjs.com/package/@plumbus/core)

## What is this?

[`Plumbus`](https://github.com/plumbus-framework/plumbus) is an AI-native, contract-driven TypeScript framework. `@plumbus/voice` adds the **voice primitive** on top of core:

- `defineVoice({...})` declares one voice surface
- `registerVoiceRoutes()` mints session tokens and mounts HTTP/WebSocket routes
- built-in transport/STT/TTS adapters cover browser, OpenAI-compatible, and realtime stacks
- every STT/TTS/transport interaction can write into the shared `onAICostRecorded` ledger

This package is for **speech I/O around your app brain**. It is **not** a speech-to-speech agent runtime that replaces capabilities, flows, prompts, or `ctx.ai`.

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| One-shot text generation inside a normal capability | `ctx.ai.generate` in `@plumbus/core` |
| A multi-turn text chat UI | [`@plumbus/chat`](../chat/) + optionally [`@plumbus/chat-ui`](../chat-ui/) |
| Registry-backed grounding for a voice/chat surface | [`@plumbus/knowledge-base`](../knowledge-base/) |
| **Realtime speech input/output with push-to-talk transport** | **`@plumbus/voice`** (this package) |

## Install

```bash
pnpm add @plumbus/voice
```

Required peer: `@plumbus/core` `^0.6.0 <0.7.0`.

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
  - [`dvora-integration.md`](../../docs/voice/dvora-integration.md) — Dvora/LiveKit continuous voice stacks
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

| Package | Purpose | When to install |
|---|---|---|
| [`@plumbus/core`](../plumbus-core/) | Foundation — capabilities, entities, events, flows, prompts, translations, runtime, CLI, audit, governance. | Always (required). |
| [`@plumbus/ui`](../ui/) | Next.js/React UI — typed API clients, auth helpers, form metadata, scaffolds. | When building a Plumbus web UI. |
| [`@plumbus/api`](../api/) | Partner external API — manifest, OpenAPI, docs, compatibility diff, test intent. | Optional peer `0.1.x` — when publishing a documented partner-facing HTTP API. |
| [`@plumbus/mcp`](../mcp/) | MCP runtime — serve capabilities to AI agents (`tools/*`, `tasks/*`, transports). | Optional peer `0.5.x` — when exposing capabilities to MCP clients. |
| [`@plumbus/chat`](../chat/) | Conversational runtime — `defineChat`, policy guards, context sources, streamed events. | Optional peer `0.1.x` — when adding a chat surface. |
| [`@plumbus/chat-ui`](../chat-ui/) | React chat UI — hooks and `<ChatPanel />` for the `@plumbus/chat` turn protocol. | Peer of `@plumbus/chat` — when adding a browser chat client. |
| [`@plumbus/knowledge-base`](../knowledge-base/) | Knowledge providers — scoped sources, registry, chat `knowledgeContext` integration. | Optional peer of `@plumbus/chat` `0.1.x` — when sharing named knowledge across features. |
| **`@plumbus/voice`** | **You are here.** Real-time voice runtime — `defineVoice`, STT/TTS/transport providers, session worker, cost ledger. | Optional peer `0.1.x` — when adding speech I/O (not speech-to-speech); complements `@plumbus/chat` text surfaces. |
| [`@plumbus/browser-extension`](../browser-extension/) | Extension scaffolder — WXT Chrome/Firefox project wired to your capabilities. | With `@plumbus/ui` (`0.1.x`) — when shipping a browser extension UI. |

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
