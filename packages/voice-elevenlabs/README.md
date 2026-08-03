# @plumbus/voice-elevenlabs

> **ElevenLabs TTS for [Plumbus](https://github.com/plumbus-framework/plumbus) voice.** Register as `tts.provider: 'elevenlabs'` and stream via the official `@elevenlabs/elevenlabs-js` SDK — flash models with native delivery params, `eleven_v3` with inline text tags (Hebrew-capable).

[![npm](https://img.shields.io/npm/v/@plumbus/voice-elevenlabs.svg)](https://www.npmjs.com/package/@plumbus/voice-elevenlabs)
[![license](https://img.shields.io/npm/l/@plumbus/voice-elevenlabs.svg)](./LICENSE)
[![peer: @plumbus/core 0.6.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.6.x-blue)](https://www.npmjs.com/package/@plumbus/core)
[![peer: @plumbus/voice 0.4.x](https://img.shields.io/badge/peer-%40plumbus%2Fvoice%200.4.x-blue)](https://www.npmjs.com/package/@plumbus/voice)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. [`@plumbus/voice`](../voice/) is the optional voice runtime.

`@plumbus/voice-elevenlabs` is the **ElevenLabs TTS adapter**. It exports `ELEVENLABS_TTS_REGISTRATION` for the voice provider registry and uses `textToSpeech.stream()` for both flash and `eleven_v3`.

## Why?

The official ElevenLabs JS SDK is large (~21 MB). Keeping it in an opt-in add-on means apps that never use ElevenLabs never pull it. The previous untested WebSocket flash path was removed — this package is the supported path.

## What you get

| Surface | What it does |
|---|---|
| `ELEVENLABS_TTS_REGISTRATION` | Factory + descriptor for `createProviderRegistry({ tts: { elevenlabs: … } })`. |
| `ELEVENLABS_TTS_DESCRIPTOR` / `ELEVENLABS_TTS_MODELS` | Catalog entry (flash capabilities) and static model list. |
| `createElevenLabsCapabilities` / `DEFAULT_ELEVENLABS_TTS_MODEL_ID` | Capability helpers for catalog / config. |
| `ELEVENLABS_VOICE_PRICING` | Pricing rows for voice cost estimation. |
| `resolveCredentialsFromEnv` | Reads `ELEVENLABS_API_KEY` / optional `ELEVENLABS_BASE_URL`. |

## Status

Optional add-on of `@plumbus/voice` `0.4.x` and `@plumbus/core` `0.6.x`. Implements official-SDK streaming TTS for flash and `eleven_v3`. Install alone does not register the provider.

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-elevenlabs
```

Peers (copy literals): `@plumbus/core` `0.6.x`, `@plumbus/voice` `0.4.x`.

Env: `ELEVENLABS_API_KEY` (optional `ELEVENLABS_BASE_URL`).

## Quick start

```ts
import { createProviderRegistry, defineVoice, registerVoiceRoutes } from '@plumbus/voice';
import { ELEVENLABS_TTS_REGISTRATION } from '@plumbus/voice-elevenlabs';
import { onRoutesRegistered } from '@plumbus/core';

export const voiceProviderRegistry = createProviderRegistry({
  tts: { elevenlabs: ELEVENLABS_TTS_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  access: { roles: ['user'] },
  transport: { provider: 'websocket', mode: 'pushToTalk' },
  stt: { provider: 'web-speech', languages: ['he-IL'] },
  tts: {
    provider: 'elevenlabs',
    model: 'eleven_v3',
    voiceId: process.env['ELEVENLABS_VOICE_ID'] ?? 'default',
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
        elevenlabs: { apiKey: process.env['ELEVENLABS_API_KEY'] },
      },
    },
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
  });
});
```

For CLI/workers, export the same `voiceProviderRegistry` from `app/voice/registry.ts`.

## Key gotchas

- **Explicit registration required** — install alone does nothing.
- **Do not import `@elevenlabs/elevenlabs-js` in app code** — this package owns the SDK boundary (lazy import on first synthesize / `listVoices`).
- **`chunkLengthSchedule` is not supported** (no SDK equivalent on `stream()`).
- Flash models use native delivery params; `eleven_v3` uses inline text tags.

## Documentation / Agent recipes

- **Concept docs:** [`docs/voice/providers.md`](../../docs/voice/providers.md), [`docs/voice/design/providers.md`](../../docs/voice/design/providers.md)
- **Upgrade guide:** [`docs/upgrading-voice-provider-packages.md`](../../docs/upgrading-voice-provider-packages.md)
- **Agent recipes** (after install, open these exact paths):
  - `node_modules/@plumbus/voice-elevenlabs/instructions/README.md`
  - `node_modules/@plumbus/voice-elevenlabs/instructions/framework.md`

## The Plumbus ecosystem

`@plumbus/voice-elevenlabs` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent package** — [`@plumbus/voice`](../voice/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
