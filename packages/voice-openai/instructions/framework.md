# @plumbus/voice-openai — Framework

**Exact path in a consumer app:** `node_modules/@plumbus/voice-openai/instructions/framework.md`

Index: `node_modules/@plumbus/voice-openai/instructions/README.md`

`@plumbus/voice-openai` is the **OpenAI STT/TTS adapter** for `@plumbus/voice`. Install it when a voice uses `stt.provider: 'openai-whisper'`, `stt.provider: 'openai-realtime'`, and/or `tts.provider: 'openai'`.

## When not to use

- Do **not** install this package for Soniox STT, Deepdub/ElevenLabs/MiniMax TTS, or LiveKit transport — those are other `@plumbus/voice-*` add-ons.
- Do **not** import the `openai` / `ws` packages in app code — this package depends on them and owns the SDK boundary (Whisper, TTS, and Realtime STT via `OpenAIRealtimeWS`).
- Skip it for browser-only / zero-cloud prototypes that should stay on `web-speech` / `browser-tts`.

**Peers (copy literals):**

```json
"@plumbus/core": "0.6.x",
"@plumbus/voice": "0.4.x"
```

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-openai
```

## Quick start

```ts
import { createProviderRegistry, defineVoice } from '@plumbus/voice';
import {
  OPENAI_REALTIME_STT_REGISTRATION,
  OPENAI_TTS_REGISTRATION,
  OPENAI_WHISPER_STT_REGISTRATION,
} from '@plumbus/voice-openai';

const registry = createProviderRegistry({
  stt: {
    'openai-whisper': OPENAI_WHISPER_STT_REGISTRATION,
    'openai-realtime': OPENAI_REALTIME_STT_REGISTRATION,
  },
  tts: { openai: OPENAI_TTS_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  // …
  stt: { provider: 'openai-realtime', model: 'gpt-realtime-whisper', languages: ['en'] },
  tts: { provider: 'openai', model: 'tts-1', voiceId: 'alloy' },
  brain: { async run(ctx, args) { /* app logic */ return 'ok'; } },
});
```

Pass `registry` into `registerVoiceRoutes()` / worker bootstrap as documented in `@plumbus/voice`.

## Key exports

| Export | Role |
|---|---|
| `OPENAI_WHISPER_STT_REGISTRATION` | Batch Whisper STT factory + descriptor |
| `OPENAI_REALTIME_STT_REGISTRATION` | Streaming Realtime STT factory + descriptor (`OpenAIRealtimeWS`) |
| `OPENAI_TTS_REGISTRATION` | OpenAI TTS factory + descriptor |
| `OPENAI_REALTIME_CONNECTION_MODEL` | Default Realtime URL/connection model (`gpt-realtime`) |
| `OPENAI_WHISPER_STT_DESCRIPTOR` / `OPENAI_REALTIME_STT_DESCRIPTOR` / `OPENAI_TTS_DESCRIPTOR` | Catalog entries |
| `resolveCredentialsFromEnv` | Read `OPENAI_API_KEY` / `OPENAI_BASE_URL` |
| `resolveVoiceOpenAICredentials` | Bridge Plumbus `aiProviders` / legacy `ai` config |

## Realtime options

- Transcription model: `stt.model` (default `gpt-realtime-whisper`)
- Connection model: `stt.options.realtimeConnectionModel` (default `OPENAI_REALTIME_CONNECTION_MODEL` / `gpt-realtime`)
- Custom bases: credential `baseUrl` / `OPENAI_BASE_URL` (HTTP or `ws`/`wss`; normalized to HTTP(S) for the SDK)

## Env vars

| Variable | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | yes | OpenAI API key |
| `OPENAI_BASE_URL` | no | Override API base for OpenAI-compatible Whisper/TTS/Realtime (SDK `baseURL`; default `https://api.openai.com/v1`) |

## CLI commands

This package ships no CLI of its own. `plumbus voice worker` and the voice routes from `@plumbus/core` / `@plumbus/voice` require explicit `*_REGISTRATION` in `createProviderRegistry()`.

## Docs

- `docs/voice/providers.md`, `docs/voice/configuration.md`, `docs/voice/cost-tracking.md` (Plumbus monorepo)
- `docs/upgrading-voice-provider-packages.md` — migrating from `@plumbus/voice` 0.3.x
- Package overview: [`../README.md`](../README.md)

## Framework-first

Keep app logic in Plumbus primitives (`defineCapability`, `ctx.*`, voice `brain`). This package adapts OpenAI's official SDK (Whisper, TTS, Realtime STT) to the voice STT/TTS contracts.

## Ecosystem

`@plumbus/voice-openai` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
