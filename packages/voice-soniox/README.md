# @plumbus/voice-soniox

> **Soniox streaming STT for [Plumbus](https://github.com/plumbus-framework/plumbus) voice.** Register as `stt.provider: 'soniox'` for multilingual, low-latency speech-to-text with live endpoint detection — without bundling `@soniox/node` into `@plumbus/voice`.

[![npm](https://img.shields.io/npm/v/@plumbus/voice-soniox.svg)](https://www.npmjs.com/package/@plumbus/voice-soniox)
[![license](https://img.shields.io/npm/l/@plumbus/voice-soniox.svg)](./LICENSE)
[![peer: @plumbus/core 0.6.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.6.x-blue)](https://www.npmjs.com/package/@plumbus/core)
[![peer: @plumbus/voice 0.4.x](https://img.shields.io/badge/peer-%40plumbus%2Fvoice%200.4.x-blue)](https://www.npmjs.com/package/@plumbus/voice)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. [`@plumbus/voice`](../voice/) is the optional voice runtime.

`@plumbus/voice-soniox` is the **Soniox STT adapter**. It exports `SONIOX_STT_REGISTRATION` for the voice provider registry, catalog descriptors, pricing, and env credential helpers.

## Why?

Soniox's Node SDK and streaming protocol are vendor-specific. Shipping them as an opt-in add-on keeps `@plumbus/voice` lean for apps that stay on browser STT or another cloud STT package.

## What you get

| Surface | What it does |
|---|---|
| `SONIOX_STT_REGISTRATION` | Factory + descriptor for `createProviderRegistry({ stt: { soniox: … } })`. |
| `SONIOX_STT_DESCRIPTOR` / `SONIOX_STT_MODELS` | Catalog entry and static model list. |
| `SONIOX_VOICE_PRICING` | Pricing rows for voice cost estimation. |
| `resolveCredentialsFromEnv` | Reads `SONIOX_API_KEY` / optional `SONIOX_BASE_URL`. |

## Status

Optional add-on of `@plumbus/voice` `0.4.x` and `@plumbus/core` `0.6.x`. Implements streaming Soniox STT registration, descriptors, pricing, and credential helpers. Install alone does not register the provider.

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-soniox
```

Peers (copy literals): `@plumbus/core` `0.6.x`, `@plumbus/voice` `0.4.x`.

Env: `SONIOX_API_KEY` (optional `SONIOX_BASE_URL`).

## Quick start

```ts
import { createProviderRegistry, defineVoice, registerVoiceRoutes } from '@plumbus/voice';
import { SONIOX_STT_REGISTRATION } from '@plumbus/voice-soniox';
import { onRoutesRegistered } from '@plumbus/core';

export const voiceProviderRegistry = createProviderRegistry({
  stt: { soniox: SONIOX_STT_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  access: { roles: ['user'] },
  transport: { provider: 'websocket', mode: 'pushToTalk' },
  stt: { provider: 'soniox', model: 'stt-rt-v5', languages: ['he', 'en'] },
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
        websocket: {},
        soniox: { apiKey: process.env['SONIOX_API_KEY'] },
        'browser-tts': {},
      },
    },
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
  });
});
```

For CLI/workers, export the same `voiceProviderRegistry` from `app/voice/registry.ts`.

## Key gotchas

- **Explicit registration required.** `createProviderRegistry({ stt: { soniox: SONIOX_STT_REGISTRATION } })` — no auto-load.
- **Do not import `@soniox/node` in app code** — this package owns the SDK boundary.

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
