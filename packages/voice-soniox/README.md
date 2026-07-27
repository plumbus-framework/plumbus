# @plumbus/voice-soniox

> **Soniox STT + TTS for [Plumbus](https://github.com/plumbus-framework/plumbus) voice.** Register `stt.provider: 'soniox'` and/or `tts.provider: 'soniox'` via the official `@soniox/node` SDK — without bundling Soniox into `@plumbus/voice`.

[![npm](https://img.shields.io/npm/v/@plumbus/voice-soniox.svg)](https://www.npmjs.com/package/@plumbus/voice-soniox)
[![license](https://img.shields.io/npm/l/@plumbus/voice-soniox.svg)](./LICENSE)
[![peer: @plumbus/core 0.6.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.6.x-blue)](https://www.npmjs.com/package/@plumbus/core)
[![peer: @plumbus/voice 0.4.x](https://img.shields.io/badge/peer-%40plumbus%2Fvoice%200.4.x-blue)](https://www.npmjs.com/package/@plumbus/voice)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. [`@plumbus/voice`](../voice/) is the optional voice runtime.

`@plumbus/voice-soniox` is the **Soniox STT and TTS adapter**. It exports `SONIOX_STT_REGISTRATION` and `SONIOX_TTS_REGISTRATION` for the voice provider registry, catalog descriptors, pricing, and env credential helpers.

## Why?

Soniox's Node SDK and streaming protocols are vendor-specific. Shipping them as an opt-in add-on keeps `@plumbus/voice` lean for apps that stay on browser STT/TTS or another cloud provider package.

## What you get

| Surface | What it does |
|---|---|
| `SONIOX_STT_REGISTRATION` | Factory + descriptor for `createProviderRegistry({ stt: { soniox: … } })`. |
| `SONIOX_TTS_REGISTRATION` | Factory + descriptor for `createProviderRegistry({ tts: { soniox: … } })`. |
| `SONIOX_STT_*` / `SONIOX_TTS_*` descriptors & models | Catalog entries and static model/voice lists. |
| `SONIOX_VOICE_PRICING` | Pricing rows for STT + TTS cost estimation (TTS is an approximate $/character stand-in for Soniox token billing). |
| `resolveCredentialsFromEnv` | Reads `SONIOX_API_KEY` / optional `SONIOX_BASE_URL`. |

## Status

Optional add-on of `@plumbus/voice` `0.4.x` and `@plumbus/core` `0.6.x`. Implements streaming Soniox STT + REST streaming TTS (`pcm_s16le` @ 16 kHz by default). Install alone does not register providers.

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-soniox
```

Peers (copy literals): `@plumbus/core` `0.6.x`, `@plumbus/voice` `0.4.x`.

Env: `SONIOX_API_KEY` (optional `SONIOX_BASE_URL`).

## Quick start

```ts
import { createProviderRegistry, defineVoice, registerVoiceRoutes } from '@plumbus/voice';
import { SONIOX_STT_REGISTRATION, SONIOX_TTS_REGISTRATION } from '@plumbus/voice-soniox';
import { onRoutesRegistered } from '@plumbus/core';

export const voiceProviderRegistry = createProviderRegistry({
  stt: { soniox: SONIOX_STT_REGISTRATION },
  tts: { soniox: SONIOX_TTS_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  access: { roles: ['user'] },
  transport: { provider: 'websocket', mode: 'pushToTalk' },
  stt: { provider: 'soniox', model: 'stt-rt-v5', languages: ['he', 'en'] },
  tts: {
    provider: 'soniox',
    model: 'tts-rt-v1',
    voiceId: 'Adrian',
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
        soniox: { apiKey: process.env['SONIOX_API_KEY'] },
      },
    },
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
  });
});
```

For CLI/workers, export the same `voiceProviderRegistry` from `app/voice/registry.ts`.

## Key gotchas

- **Explicit registration required** — install alone does nothing. Register STT and/or TTS independently.
- **Do not import `@soniox/node` in app code** — this package owns the SDK boundary.
- TTS defaults to raw **`pcm_s16le` @ 16 kHz** (aligned with transport `pcm16-16k`). Override with `tts.options.format` / `sampleRate` if needed.
- Locale `he-IL` maps to Soniox language code `he`.

## Documentation / Agent recipes

- **Concept docs:** [`docs/voice/providers.md`](../../docs/voice/providers.md), [`docs/voice/configuration.md`](../../docs/voice/configuration.md)
- **Upgrade guide:** [`docs/upgrading-voice-provider-packages.md`](../../docs/upgrading-voice-provider-packages.md)
- **Agent recipes** (after install, open these exact paths):
  - `node_modules/@plumbus/voice-soniox/instructions/README.md`
  - `node_modules/@plumbus/voice-soniox/instructions/framework.md`

## The Plumbus ecosystem

`@plumbus/voice-soniox` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent package** — [`@plumbus/voice`](../voice/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
