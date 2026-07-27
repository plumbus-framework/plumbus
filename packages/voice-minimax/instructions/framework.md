# @plumbus/voice-minimax — Framework

**Exact path in a consumer app:** `node_modules/@plumbus/voice-minimax/instructions/framework.md`

Index: `node_modules/@plumbus/voice-minimax/instructions/README.md`

`@plumbus/voice-minimax` is the **MiniMax TTS adapter** for `@plumbus/voice`. Install it when a voice uses `tts.provider: 'minimax'`.

## When not to use

- Do **not** install this package for OpenAI, browser, Deepdub, or ElevenLabs TTS — those are separate providers (built-in or other `@plumbus/voice-*` add-ons).
- Do **not** call MiniMax HTTP/WebSocket APIs from app code; this package owns the wire protocol.
- Skip it for local/offline stacks that should stay on `browser-tts` / `openai`.

**Peers (copy literals):**

```json
"@plumbus/core": "0.6.x",
"@plumbus/voice": "0.4.x"
```

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-minimax
```

## Quick start

```ts
import { createProviderRegistry, defineVoice } from '@plumbus/voice';
import { MINIMAX_TTS_REGISTRATION } from '@plumbus/voice-minimax';

const registry = createProviderRegistry({
  tts: { minimax: MINIMAX_TTS_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  // …
  tts: { provider: 'minimax', model: 'speech-2.8-turbo', voiceId: '…', locale: 'he-IL' },
  brain: { async run(ctx, args) { /* app logic */ return 'ok'; } },
});
```

Pass `registry` into `registerVoiceRoutes()` / worker bootstrap as documented in `@plumbus/voice`.

## Key exports

| Export | Role |
|---|---|
| `MINIMAX_TTS_REGISTRATION` | Factory + descriptor for the provider registry |
| `MINIMAX_TTS_DESCRIPTOR` | Catalog entry (`id: 'minimax'`) |

## Env vars

| Variable | Required | Purpose |
|---|---|---|
| `MINIMAX_API_KEY` | yes | MiniMax API key |
| `MINIMAX_BASE_URL` | no | Override API base (default `https://api.minimax.io`) |

## Wire notes

- **Audio defaults:** `audio_setting` is mono `pcm` at **16 kHz** (aligned with transport `pcm16-16k`). The voice runtime publishes/forwards raw PCM16 chunks with no mp3 decode — override with `tts.options.format` / `sampleRate` / `channel` / `bitrate` when needed (`bitrate` is sent only for `mp3`).
- **Pitch:** delivery `warmth` maps to integer semitones (`low=-2`, `medium=0`, `high=2`), clamped to `[-12, 12]`.
- **Emotions:** `whisper` and `fluent` are valid only on `speech-2.6-*`; they are omitted on `speech-2.8-*`.
- **Voice catalog:** `listVoices` calls `POST /v1/get_voice` with `{ "voice_type": "all" }` and merges `system_voice` + `voice_cloning`.

## CLI commands

This package ships no CLI of its own. `plumbus voice worker` and the voice routes from `@plumbus/core` / `@plumbus/voice` require explicit `*_REGISTRATION` in `createProviderRegistry()`.

## Docs

- `docs/voice/providers.md`, `docs/voice/configuration.md`, `docs/voice/cost-tracking.md` (Plumbus monorepo)
- `docs/upgrading-voice-provider-packages.md` — migrating from `@plumbus/voice` 0.3.x
- Package overview: [`../README.md`](../README.md)

## Framework-first

Keep app logic in Plumbus primitives (`defineCapability`, `ctx.*`, voice `brain`). This package only adapts MiniMax HTTP/WebSocket wire formats to the voice TTS contract.

## Ecosystem

`@plumbus/voice-minimax` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
