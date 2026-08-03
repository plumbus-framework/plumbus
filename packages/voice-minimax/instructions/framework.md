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
| `MINIMAX_GROUP_ID` | no | Optional account `GroupId` query param (also `credentials.options.groupId`) |

## Wire notes

- **Audio defaults:** `audio_setting` is mono `pcm` at **16 kHz** (aligned with transport `pcm16-16k`). The voice runtime publishes/forwards raw PCM16 chunks with no mp3 decode — override with `tts.options.format` / `sampleRate` / `channel` / `bitrate` when needed (`bitrate` is sent only for `mp3`). Values are validated against MiniMax enums (`sampleRate`: 8/16/22.05/24/32/44.1 kHz; streaming formats: `pcm`/`mp3`/`flac`/`pcmu_*`/`opus`; no streaming `wav`).
- **Pitch:** delivery `warmth` maps to integer semitones (`low=-2`, `medium=0`, `high=2`), clamped to `[-12, 12]`.
- **Emotions:** `whisper` and `fluent` are valid only on `speech-2.6-*`; they are omitted on `speech-2.8-*`.
- **Optional wire passthroughs:** `tts.options.textNormalization` → `voice_setting.text_normalization`; `tts.options.forceCbr` → `audio_setting.force_cbr`; `tts.options.voiceModify` → `voice_modify` (`pitch` / `intensity` / `timbre` / `soundEffects`).
- **Voice catalog:** `listVoices` calls `POST /v1/get_voice` with `{ "voice_type": "all" }` and merges `system_voice` + `voice_cloning` + `voice_generation`.
- **API errors:** MiniMax often returns HTTP 200 with failures in `base_resp.status_code`. The adapter throws `PlumbusError` when `status_code !== 0`, mapping auth → `Unauthorized`, validation → `Validation`, rate-limit → `Internal` + `metadata.category: 'rateLimit'`, and includes `trace_id` when present. HTTP SSE is parsed with `eventsource-parser`.
- **HTTP stream audio:** only `data.status === 1` chunks are played; status `2` is treated as final/metadata (may carry aggregated audio and `extra_info.usage_characters`).
- **Billing:** usage falls back to input text length, then prefers vendor `usage_characters` when MiniMax returns it.

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
