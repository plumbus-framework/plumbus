# @plumbus/voice-deepdub

> **Deepdub TTS for [Plumbus](https://github.com/plumbus-framework/plumbus) voice.** Register as `tts.provider: 'deepdub'` for streaming synthesis with full delivery-tone support and strong Hebrew quality via `@deepdub/node`.

[![npm](https://img.shields.io/npm/v/@plumbus/voice-deepdub.svg)](https://www.npmjs.com/package/@plumbus/voice-deepdub)
[![license](https://img.shields.io/npm/l/@plumbus/voice-deepdub.svg)](./LICENSE)
[![peer: @plumbus/core 0.6.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.6.x-blue)](https://www.npmjs.com/package/@plumbus/core)
[![peer: @plumbus/voice 0.4.x](https://img.shields.io/badge/peer-%40plumbus%2Fvoice%200.4.x-blue)](https://www.npmjs.com/package/@plumbus/voice)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. [`@plumbus/voice`](../voice/) is the optional voice runtime.

`@plumbus/voice-deepdub` is the **Deepdub TTS adapter**. It exports `DEEPDUB_TTS_REGISTRATION` for the voice provider registry, catalog descriptors, pricing, and env credential helpers.

## Why?

Deepdub's Node SDK is a heavy, vendor-specific dependency. Shipping it as an opt-in add-on keeps browser-only and other-cloud stacks free of that weight while still giving Hebrew-first production voices a first-class registration path.

## What you get

| Surface | What it does |
|---|---|
| `DEEPDUB_TTS_REGISTRATION` | Factory + descriptor for `createProviderRegistry({ tts: { deepdub: … } })`. |
| `DEEPDUB_TTS_DESCRIPTOR` / `DEEPDUB_TTS_MODELS` | Catalog entry and static model list. |
| `DEEPDUB_VOICE_PRICING` | Pricing rows for voice cost estimation. |
| `resolveCredentialsFromEnv` | Reads `DEEPDUB_API_KEY` / optional `DEEPDUB_BASE_URL`. |

## Status

Optional add-on of `@plumbus/voice` `0.4.x` and `@plumbus/core` `0.6.x`. Implements streaming Deepdub TTS with delivery-tone mapping. Install alone does not register the provider.

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-deepdub
```

Peers (copy literals): `@plumbus/core` `0.6.x`, `@plumbus/voice` `0.4.x`.

Env: `DEEPDUB_API_KEY` (optional `DEEPDUB_BASE_URL`).

## Quick start

```ts
import { createProviderRegistry, defineVoice, registerVoiceRoutes } from '@plumbus/voice';
import { DEEPDUB_TTS_REGISTRATION } from '@plumbus/voice-deepdub';
import { onRoutesRegistered } from '@plumbus/core';

export const voiceProviderRegistry = createProviderRegistry({
  tts: { deepdub: DEEPDUB_TTS_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  access: { roles: ['user'] },
  transport: { provider: 'websocket', mode: 'pushToTalk' },
  stt: { provider: 'web-speech', languages: ['he-IL'] },
  tts: {
    provider: 'deepdub',
    voiceId: process.env['DEEPDUB_VOICE_ID'] ?? 'default',
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
        deepdub: { apiKey: process.env['DEEPDUB_API_KEY'] },
      },
    },
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
  });
});
```

For CLI/workers, export the same `voiceProviderRegistry` from `app/voice/registry.ts`.

## Key gotchas

- **Explicit registration required** — install alone does nothing.
- **Do not import `@deepdub/node` in app code** — this package owns the SDK boundary.

## Documentation / Agent recipes

- **Concept docs:** [`docs/voice/providers.md`](../../docs/voice/providers.md), [`docs/voice/cost-tracking.md`](../../docs/voice/cost-tracking.md)
- **Upgrade guide:** [`docs/upgrading-voice-provider-packages.md`](../../docs/upgrading-voice-provider-packages.md)
- **Agent recipes** (after install, open these exact paths):
  - `node_modules/@plumbus/voice-deepdub/instructions/README.md`
  - `node_modules/@plumbus/voice-deepdub/instructions/framework.md`

## The Plumbus ecosystem

`@plumbus/voice-deepdub` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent package** — [`@plumbus/voice`](../voice/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
