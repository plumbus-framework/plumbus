# @plumbus/voice-soniox — Framework

**Exact path in a consumer app:** `node_modules/@plumbus/voice-soniox/instructions/framework.md`

Index: `node_modules/@plumbus/voice-soniox/instructions/README.md`

`@plumbus/voice-soniox` is the **Soniox STT and TTS adapter** for `@plumbus/voice`. Install it when a voice uses `stt.provider: 'soniox'` and/or `tts.provider: 'soniox'`.

## When not to use

- Do **not** install this package for `web-speech` / `browser-tts` (builtin) or OpenAI STT/TTS (`@plumbus/voice-openai`).
- Do **not** import `@soniox/node` directly in app code; this package owns the SDK boundary.
- Skip it for browser-only / zero-cloud prototypes that should stay on builtins.

**Peers (copy literals):**

```json
"@plumbus/core": "0.6.x",
"@plumbus/voice": "0.4.x"
```

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-soniox
```

## Quick start

```ts
import { createProviderRegistry, defineVoice } from '@plumbus/voice';
import { SONIOX_STT_REGISTRATION, SONIOX_TTS_REGISTRATION } from '@plumbus/voice-soniox';

const registry = createProviderRegistry({
  stt: { soniox: SONIOX_STT_REGISTRATION },
  tts: { soniox: SONIOX_TTS_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  // …
  stt: { provider: 'soniox', model: 'stt-rt-v5', languages: ['he', 'en'] },
  tts: { provider: 'soniox', model: 'tts-rt-v1', voiceId: 'Adrian', locale: 'he-IL' },
  brain: { async run(ctx, args) { /* app logic */ return 'ok'; } },
});
```

Pass `registry` into `registerVoiceRoutes()` / worker bootstrap as documented in `@plumbus/voice`. Register only the surfaces you need (STT, TTS, or both).

## Key exports

| Export | Role |
|---|---|
| `SONIOX_STT_REGISTRATION` | STT factory + descriptor (`id: 'soniox'`) |
| `SONIOX_TTS_REGISTRATION` | TTS factory + descriptor (`id: 'soniox'`) |
| `SONIOX_STT_DESCRIPTOR` / `SONIOX_TTS_DESCRIPTOR` | Catalog entries |
| `SONIOX_TTS_VOICES` | Static built-in TTS voice list |

## Env vars

| Variable | Required | Purpose |
|---|---|---|
| `SONIOX_API_KEY` | yes | Soniox API key (shared by STT + TTS) |
| `SONIOX_BASE_URL` | no | Override API base when supported by credentials |

## Wire notes

- **STT:** realtime SDK session (`client.realtime.stt`) with endpoint detection.
- **TTS:** REST streaming via `client.tts.generateStream()`; defaults to `pcm_s16le` @ **16 kHz** (aligned with transport `pcm16-16k`). Override with `tts.options.format` / `sampleRate` / `bitrate`. Forwards `AbortSignal` as SDK `signal`.
- **Clone:** `client.tts.voices.*` on `SONIOX_TTS_REGISTRATION.clone` (`@soniox/node` ^2.2.0). UUID `voice` = clone id in `generateStream`. Catalog `listVoices` stays built-ins; user clones via clone provider + app DB.
- **Locale:** `he-IL` → Soniox language `he` (prefix before `-`).
- **Pricing:** `SONIOX_VOICE_PRICING['soniox-stt']` / `['soniox-tts']` attached on the matching registration. TTS `$/character` is approximate vs Soniox token billing.

## CLI commands

This package ships no CLI of its own. `plumbus voice worker` and the voice routes from `@plumbus/core` / `@plumbus/voice` require explicit `*_REGISTRATION` in `createProviderRegistry()`.

## Docs

- `docs/voice/providers.md`, `docs/voice/configuration.md`, `docs/voice/cost-tracking.md`, `docs/voice/voice-cloning.md` (Plumbus monorepo)
- `docs/upgrading-voice-provider-packages.md` — migrating from `@plumbus/voice` 0.3.x
- Package overview: [`../README.md`](../README.md)

## Framework-first

Keep app logic in Plumbus primitives (`defineCapability`, `ctx.*`, voice `brain`). This package only adapts Soniox's SDK to the voice STT/TTS contracts.

## Ecosystem

`@plumbus/voice-soniox` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
