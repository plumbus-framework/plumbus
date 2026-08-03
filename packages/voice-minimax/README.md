# @plumbus/voice-minimax

> **MiniMax TTS for [Plumbus](https://github.com/plumbus-framework/plumbus) voice.** Register as `tts.provider: 'minimax'` for streaming synthesis with full delivery tone and Hebrew language boost — without embedding MiniMax wire protocol in `@plumbus/voice`.

[![npm](https://img.shields.io/npm/v/@plumbus/voice-minimax.svg)](https://www.npmjs.com/package/@plumbus/voice-minimax)
[![license](https://img.shields.io/npm/l/@plumbus/voice-minimax.svg)](./LICENSE)
[![peer: @plumbus/core 0.6.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.6.x-blue)](https://www.npmjs.com/package/@plumbus/core)
[![peer: @plumbus/voice 0.4.x](https://img.shields.io/badge/peer-%40plumbus%2Fvoice%200.4.x-blue)](https://www.npmjs.com/package/@plumbus/voice)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. [`@plumbus/voice`](../voice/) is the optional voice runtime.

`@plumbus/voice-minimax` is the **MiniMax TTS adapter**. It exports `MINIMAX_TTS_REGISTRATION` for the voice provider registry, owns the HTTP/WebSocket wire protocol, and maps delivery tone (including pitch / emotion constraints per model family).

## Why?

MiniMax synthesis uses a vendor-specific wire format and catalog API. Shipping it as an opt-in add-on keeps `@plumbus/voice` free of that protocol while still giving apps a first-class `tts.provider: 'minimax'` registration.

## What you get

| Surface | What it does |
|---|---|
| `MINIMAX_TTS_REGISTRATION` | Factory + descriptor for `createProviderRegistry({ tts: { minimax: … } })`. |
| `MINIMAX_TTS_DESCRIPTOR` / `MINIMAX_TTS_MODELS` | Catalog entry and static model list. |
| `MINIMAX_VOICE_PRICING` | Pricing rows for voice cost estimation. |
| `resolveCredentialsFromEnv` | Reads `MINIMAX_API_KEY` / optional `MINIMAX_BASE_URL`. |

## Status

Optional add-on of `@plumbus/voice` `0.4.x` and `@plumbus/core` `0.6.x`. Implements streaming MiniMax TTS with delivery-tone mapping and language boost. Install alone does not register the provider.

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-minimax
```

Peers (copy literals): `@plumbus/core` `0.6.x`, `@plumbus/voice` `0.4.x`.

Env: `MINIMAX_API_KEY` (optional `MINIMAX_BASE_URL`, `MINIMAX_GROUP_ID`).

## Quick start

```ts
import { createProviderRegistry, defineVoice, registerVoiceRoutes } from '@plumbus/voice';
import { MINIMAX_TTS_REGISTRATION } from '@plumbus/voice-minimax';
import { onRoutesRegistered } from '@plumbus/core';

export const voiceProviderRegistry = createProviderRegistry({
  tts: { minimax: MINIMAX_TTS_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  access: { roles: ['user'] },
  transport: { provider: 'websocket', mode: 'pushToTalk' },
  stt: { provider: 'web-speech', languages: ['he-IL'] },
  tts: {
    provider: 'minimax',
    model: 'speech-2.8-turbo',
    voiceId: process.env['MINIMAX_VOICE_ID'] ?? 'default',
    locale: 'he-IL',
  },
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
        websocket: {},
        'web-speech': {},
        minimax: { apiKey: process.env['MINIMAX_API_KEY'] },
      },
    },
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
  });
});
```

For CLI/workers, export the same `voiceProviderRegistry` from `app/voice/registry.ts`.

## Key gotchas

- **Explicit registration required** — install alone does nothing.
- **Do not call MiniMax HTTP/WebSocket APIs from app code** — this package owns the wire protocol.
- Audio defaults to mono PCM at **16 kHz** (aligned with transport `pcm16-16k`). Emotion tags `whisper` / `fluent` are valid only on `speech-2.6-*`.
- MiniMax API failures often arrive as HTTP 200 with `base_resp.status_code !== 0`; the adapter maps them to `Unauthorized` / `Validation` / rate-limit metadata (plus `trace_id` when present).
- HTTP SSE plays only `data.status === 1` chunks; status `2` is metadata (and may include billable `usage_characters`).
- Streaming does not support `wav` — keep the default `pcm` (or use `mp3` / `flac` / `opus` / `pcmu_*`). `sampleRate` / `bitrate` / `channel` are validated against MiniMax enums.
- Optional `tts.options`: `textNormalization`, `forceCbr`, `voiceModify` (`pitch` / `intensity` / `timbre` / `soundEffects`).
- Some MiniMax accounts need `GroupId` (`MINIMAX_GROUP_ID` or `providers.minimax.options.groupId`).

## Documentation / Agent recipes

- **Concept docs:** [`docs/voice/providers.md`](../../docs/voice/providers.md), [`docs/voice/cost-tracking.md`](../../docs/voice/cost-tracking.md)
- **Upgrade guide:** [`docs/upgrading-voice-provider-packages.md`](../../docs/upgrading-voice-provider-packages.md)
- **Agent recipes** (after install, open these exact paths):
  - `node_modules/@plumbus/voice-minimax/instructions/README.md`
  - `node_modules/@plumbus/voice-minimax/instructions/framework.md`

## The Plumbus ecosystem

`@plumbus/voice-minimax` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent package** — [`@plumbus/voice`](../voice/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
