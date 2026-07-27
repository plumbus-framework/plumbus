# @plumbus/voice-elevenlabs — Framework

**Exact path in a consumer app:** `node_modules/@plumbus/voice-elevenlabs/instructions/framework.md`

Index: `node_modules/@plumbus/voice-elevenlabs/instructions/README.md`

`@plumbus/voice-elevenlabs` is the **ElevenLabs TTS adapter** for `@plumbus/voice`. Install it when a voice uses `tts.provider: 'elevenlabs'`.

## When not to use

- Do **not** install this package for OpenAI, browser, Deepdub, or MiniMax TTS — those are separate providers (built-in or other `@plumbus/voice-*` add-ons).
- Do **not** import `@elevenlabs/elevenlabs-js` directly in app code; this package owns the SDK boundary (~21 MB).
- Skip it for local/offline stacks that should stay on `browser-tts` / `openai`.

**Peers (copy literals):**

```json
"@plumbus/core": "0.6.x",
"@plumbus/voice": "0.4.x"
```

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-elevenlabs
```

## Quick start

```ts
import { createProviderRegistry, defineVoice } from '@plumbus/voice';
import { ELEVENLABS_TTS_REGISTRATION } from '@plumbus/voice-elevenlabs';

const registry = createProviderRegistry({
  tts: { elevenlabs: ELEVENLABS_TTS_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  // …
  tts: { provider: 'elevenlabs', model: 'eleven_v3', voiceId: '…', locale: 'he-IL' },
  brain: { async run(ctx, args) { /* app logic */ return 'ok'; } },
});
```

Pass `registry` into `registerVoiceRoutes()` / worker bootstrap as documented in `@plumbus/voice`.

## SDK client

Synthesis and voice listing use the official `@elevenlabs/elevenlabs-js` client:

- TTS: `client.textToSpeech.stream()` (flash and `eleven_v3`)
- Catalog: `client.voices.search()`

The SDK is imported lazily on first synthesize / `listVoices` call. For tests (or custom clients), inject:

```ts
providers: {
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    options: {
      elevenLabsClientFactory: ({ apiKey, baseUrl }) => new ElevenLabsClient({ apiKey, baseUrl }),
    },
  },
},
```

`chunkLengthSchedule` is not supported (no SDK equivalent on `stream()`).

## Key exports

| Export | Role |
|---|---|
| `ELEVENLABS_TTS_REGISTRATION` | Factory + descriptor for the provider registry |
| `ELEVENLABS_TTS_DESCRIPTOR` | Default catalog entry (flash capabilities) |

## Env vars

| Variable | Required | Purpose |
|---|---|---|
| `ELEVENLABS_API_KEY` | yes | ElevenLabs API key |
| `ELEVENLABS_BASE_URL` | no | Override API base (default `https://api.elevenlabs.io`) |

## CLI commands

This package ships no CLI of its own. `plumbus voice worker` and the voice routes from `@plumbus/core` / `@plumbus/voice` require explicit `*_REGISTRATION` in `createProviderRegistry()`.

## Docs

- `docs/voice/providers.md`, `docs/voice/design/providers.md` (flash vs v3 delivery), `docs/voice/configuration.md`
- `docs/upgrading-voice-provider-packages.md` — migrating from `@plumbus/voice` 0.3.x
- Package overview: [`../README.md`](../README.md)

## Framework-first

Keep app logic in Plumbus primitives (`defineCapability`, `ctx.*`, voice `brain`). This package only adapts ElevenLabs SDK calls to the voice TTS contract.

## Ecosystem

`@plumbus/voice-elevenlabs` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
