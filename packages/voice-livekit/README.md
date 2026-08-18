# @plumbus/voice-livekit

> **LiveKit transport, agent worker, and browser session helpers for [Plumbus](https://github.com/plumbus-framework/plumbus) voice.** Register as `transport.provider: 'livekit'`, mint room tokens, join agent workers, and run continuous or push-to-talk sessions without pulling LiveKit into `@plumbus/voice` itself.

[![npm](https://img.shields.io/npm/v/@plumbus/voice-livekit.svg)](https://www.npmjs.com/package/@plumbus/voice-livekit)
[![license](https://img.shields.io/npm/l/@plumbus/voice-livekit.svg)](./LICENSE)
[![peer: @plumbus/core 0.6.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.6.x-blue)](https://www.npmjs.com/package/@plumbus/core)
[![peer: @plumbus/voice 0.4.x](https://img.shields.io/badge/peer-%40plumbus%2Fvoice%200.4.x-blue)](https://www.npmjs.com/package/@plumbus/voice)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. [`@plumbus/voice`](../voice/) is the optional voice runtime (`defineVoice`, routes, provider registry).

`@plumbus/voice-livekit` is the **LiveKit adapter** for that runtime. It owns the vendor SDK boundary for:

- Transport registration (`LIVEKIT_TRANSPORT_REGISTRATION` → `transport.provider: 'livekit'`)
- Participant token minting and room session metadata
- Agent worker entry (`startVoiceAgentWorker`, `createVoiceAgentEntry`, `joinVoiceRoomSession`)
- Browser session helpers (`createLiveKitVoiceSession` on `./client`)
- Inbound noise-cancellation helpers (Krisp / RNNoise / DTLN) and LiveKit transport cost rows

If you're not using `@plumbus/voice`, this package has nothing to plug into. Install alone does **not** register LiveKit — you must pass `LIVEKIT_TRANSPORT_REGISTRATION` into `createProviderRegistry()`.

## Why?

LiveKit (and its agent/noise-cancellation SDKs) are heavy. Keeping them out of `@plumbus/voice` means apps that only need `websocket` + browser STT/TTS never pay the install or bundle cost. This package is the explicit opt-in for room-based and continuous voice stacks.

## What you get

| Surface | What it does |
|---|---|
| `LIVEKIT_TRANSPORT_REGISTRATION` | Factory + descriptor for `createProviderRegistry({ transport: { livekit: … } })`. |
| `LIVEKIT_TRANSPORT_DESCRIPTOR` | Catalog entry (`id: 'livekit'`). |
| `mintLiveKitParticipantToken` | Server-side participant JWT for `/token` / room join. |
| `startVoiceAgentWorker` / `createVoiceAgentEntry` / `joinVoiceRoomSession` | Agent dispatch and room-join worker APIs. |
| `createInboundAudioStream` / `resolveAgentNoiseCancellationOption` | Agent-side NC wiring. |
| `parseLiveKitParticipantContext` / `buildBrainInputFromParticipantContext` | Participant metadata → brain input. |
| `recordLiveKitTransportCost` / `LIVEKIT_VOICE_PRICING` | Transport spend into the shared AI ledger. |
| `@plumbus/voice-livekit/client` | `createLiveKitVoiceSession`, `applyClientNoiseCancellation`, PCM helpers. |
| `@plumbus/voice-livekit/worker` | Agent worker entry helpers for `plumbus voice worker`. |

## Status

Optional add-on of `@plumbus/voice` `0.4.x` and `@plumbus/core` `0.6.x`. Implements LiveKit transport registration, agent worker bootstrap, browser session helpers, NC engines, and transport cost recording. WebSocket transport stays built into `@plumbus/voice`.

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-livekit
```

Peers (copy literals):

- `@plumbus/core` `0.6.x` — required
- `@plumbus/voice` `0.4.x` — required
- `livekit-client` `^2.0.0` — optional; needed for browser sessions
- `@livekit/krisp-noise-filter` `^0.4.0` — optional; client Krisp NC
- `fastify` `^5.0.0` — optional peer (reserved for app servers)

Env: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

## Quick start

```ts
import { createProviderRegistry, defineVoice, registerVoiceRoutes } from '@plumbus/voice';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '@plumbus/voice-livekit';
import { onRoutesRegistered } from '@plumbus/core';

export const voiceProviderRegistry = createProviderRegistry({
  transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
  // also register STT/TTS *_REGISTRATION from other @plumbus/voice-* packages
});

export const supportVoice = defineVoice({
  name: 'support',
  access: { roles: ['user'] },
  transport: { provider: 'livekit', mode: 'continuous' },
  stt: { provider: 'web-speech', languages: ['en-US'] },
  tts: { provider: 'browser-tts', locale: 'en-US', voiceId: 'default' },
  brain: {
    async run(_ctx, args) {
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
        'web-speech': {},
        'browser-tts': {},
      },
    },
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
  });
});
```

Export the same `voiceProviderRegistry` from `app/voice/registry.ts` so `plumbus voice worker` can load it. Use `beforeSession.room` (not `.livekit`) for `/token` mint options.

Browser client:

```ts
import { createLiveKitVoiceSession } from '@plumbus/voice-livekit/client';
```

## Key gotchas

- **Install alone does not register.** Pass `LIVEKIT_TRANSPORT_REGISTRATION` into `createProviderRegistry` and pass that registry to routes/workers.
- **No soft auto-load.** There is no `createRegistryForVoices` / `VOICE_ADDON_PACKAGES` path — CLI/workers require `app/voice/registry.ts`.
- **Import moves from 0.3.x:** session helpers → `@plumbus/voice-livekit/client`; worker helpers → `@plumbus/voice-livekit`. See [`docs/upgrading-voice-provider-packages.md`](../../docs/upgrading-voice-provider-packages.md).
- **Do not import `@livekit/*` / `livekit-client` directly** for Plumbus voice sessions — use this package's exports.

## Documentation / Agent recipes

- **Concept docs:** [`docs/voice/livekit-continuous-voice.md`](../../docs/voice/livekit-continuous-voice.md), [`docs/voice/transports.md`](../../docs/voice/transports.md), [`docs/voice/noise-cancellation.md`](../../docs/voice/noise-cancellation.md)
- **Upgrade guide:** [`docs/upgrading-voice-provider-packages.md`](../../docs/upgrading-voice-provider-packages.md)
- **Agent recipes** (after install, open these exact paths):
  - `node_modules/@plumbus/voice-livekit/instructions/README.md` — index + critical rules
  - `node_modules/@plumbus/voice-livekit/instructions/framework.md` — install, peers, exports, registration
  - `node_modules/@plumbus/voice-livekit/instructions/client-session.md` — browser session
  - `node_modules/@plumbus/voice-livekit/instructions/agent-worker.md` — worker / CLI
  - `node_modules/@plumbus/voice-livekit/instructions/noise-cancellation.md` — NC matrix
  - `node_modules/@plumbus/voice/instructions/continuous-sessions.md` — talk-over re-queue, stitched transcripts, sentence chunker

## The Plumbus ecosystem

`@plumbus/voice-livekit` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent package** — [`@plumbus/voice`](../voice/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
