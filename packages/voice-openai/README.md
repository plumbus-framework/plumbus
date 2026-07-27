# @plumbus/voice-openai

> **OpenAI Whisper / Realtime STT and OpenAI TTS for [Plumbus](https://github.com/plumbus-framework/plumbus) voice.** Register the three `*_REGISTRATION` exports you need — OpenAI is **not** built into `@plumbus/voice`.

[![npm](https://img.shields.io/npm/v/@plumbus/voice-openai.svg)](https://www.npmjs.com/package/@plumbus/voice-openai)
[![license](https://img.shields.io/npm/l/@plumbus/voice-openai.svg)](./LICENSE)
[![peer: @plumbus/core 0.6.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.6.x-blue)](https://www.npmjs.com/package/@plumbus/core)
[![peer: @plumbus/voice 0.4.x](https://img.shields.io/badge/peer-%40plumbus%2Fvoice%200.4.x-blue)](https://www.npmjs.com/package/@plumbus/voice)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. [`@plumbus/voice`](../voice/) is the optional voice runtime; its built-ins are only `websocket`, `web-speech`, and `browser-tts`.

`@plumbus/voice-openai` is the **OpenAI STT/TTS adapter**. Install it when a voice uses:

| Config id | Kind | Registration export |
|---|---|---|
| `openai-whisper` | STT (batch) | `OPENAI_WHISPER_STT_REGISTRATION` |
| `openai-realtime` | STT (streaming) | `OPENAI_REALTIME_STT_REGISTRATION` |
| `openai` | TTS | `OPENAI_TTS_REGISTRATION` |

Talks to OpenAI over HTTP/WebSocket with `fetch` / runtime WebSocket helpers — no separate `openai` npm SDK required.

## Why?

OpenAI STT/TTS used to ship inside `@plumbus/voice`. Extracting them keeps the core package lean for browser-only prototypes and makes the registration model consistent with every other cloud vendor: install the add-on, pass `*_REGISTRATION` into `createProviderRegistry()`, done.

Use this package when you want Whisper (including a Whisper-compatible local `baseUrl`), Realtime streaming STT, and/or OpenAI TTS.

## What you get

| Surface | What it does |
|---|---|
| `OPENAI_WHISPER_STT_REGISTRATION` | Batch Whisper STT factory + descriptor (`stt.provider: 'openai-whisper'`). |
| `OPENAI_REALTIME_STT_REGISTRATION` | Streaming Realtime STT factory + descriptor (`stt.provider: 'openai-realtime'`). |
| `OPENAI_TTS_REGISTRATION` | OpenAI TTS factory + descriptor (`tts.provider: 'openai'`). |
| `OPENAI_*_DESCRIPTOR` / model & voice lists | Catalog entries for admin / stack UIs. |
| `OPENAI_VOICE_PRICING` | Pricing rows for voice cost estimation. |
| `resolveCredentialsFromEnv` | Reads `OPENAI_API_KEY` / optional `OPENAI_BASE_URL`. |
| `resolveVoiceOpenAICredentials` | Bridges Plumbus `aiProviders` / legacy `ai` config into voice credential shapes. |

## Status

Optional add-on of `@plumbus/voice` `0.4.x` and `@plumbus/core` `0.6.x`. Implements Whisper batch STT, Realtime streaming STT, and OpenAI TTS with pace-only delivery tone. Install alone does not register any provider.

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-openai
```

Peers (copy literals): `@plumbus/core` `0.6.x`, `@plumbus/voice` `0.4.x`.

Env: `OPENAI_API_KEY` (optional `OPENAI_BASE_URL`, default `https://api.openai.com/v1`). For a self-hosted Whisper-compatible sidecar, set `baseUrl` on the `openai-whisper` provider config — do not invent a new adapter.

## Quick start

```ts
import { createProviderRegistry, defineVoice, registerVoiceRoutes } from '@plumbus/voice';
import {
  OPENAI_REALTIME_STT_REGISTRATION,
  OPENAI_TTS_REGISTRATION,
  OPENAI_WHISPER_STT_REGISTRATION,
} from '@plumbus/voice-openai';
import { onRoutesRegistered } from '@plumbus/core';

export const voiceProviderRegistry = createProviderRegistry({
  stt: {
    'openai-whisper': OPENAI_WHISPER_STT_REGISTRATION,
    'openai-realtime': OPENAI_REALTIME_STT_REGISTRATION,
  },
  tts: { openai: OPENAI_TTS_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  access: { roles: ['user'] },
  transport: { provider: 'websocket', mode: 'pushToTalk' },
  stt: {
    provider: 'openai-realtime',
    model: 'gpt-realtime-whisper',
    languages: ['en'],
  },
  tts: { provider: 'openai', model: 'tts-1', voiceId: 'alloy' },
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
        'openai-realtime': { apiKey: process.env['OPENAI_API_KEY'] },
        openai: { apiKey: process.env['OPENAI_API_KEY'] },
      },
    },
    sessionTokenSecret: process.env['VOICE_SESSION_TOKEN_SECRET'],
  });
});
```

Register only the exports your voices actually use. For CLI/workers, export the same `voiceProviderRegistry` from `app/voice/registry.ts` (optional `voiceProviders` for credentials).

## Key gotchas

- **OpenAI is not built into `@plumbus/voice`.** Missing registration fails with `voice.provider_package_missing` — install **and** register.
- **No auto-load** — there is no `VOICE_ADDON_PACKAGES` / `createRegistryForVoices` soft path.
- **Whisper local sidecars:** keep `stt.provider: 'openai-whisper'` and override `baseUrl`; do not invent a parallel adapter.
- **TTS tone is pace-only** on OpenAI.

## Documentation / Agent recipes

- **Concept docs:** [`docs/voice/providers.md`](../../docs/voice/providers.md), [`docs/voice/local-providers.md`](../../docs/voice/local-providers.md), [`docs/voice/configuration.md`](../../docs/voice/configuration.md)
- **Upgrade guide:** [`docs/upgrading-voice-provider-packages.md`](../../docs/upgrading-voice-provider-packages.md)
- **Agent recipes** (after install, open these exact paths):
  - `node_modules/@plumbus/voice-openai/instructions/README.md`
  - `node_modules/@plumbus/voice-openai/instructions/framework.md`

## The Plumbus ecosystem

`@plumbus/voice-openai` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent package** — [`@plumbus/voice`](../voice/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
