# Providers

`@plumbus/voice` separates voice infrastructure into three provider kinds:

- **transport** — how a session is established and audio/data move in realtime
- **STT** — how speech becomes text
- **TTS** — how text becomes speech

That lets apps mix stacks deliberately instead of buying into a monolith.

## Built-in adapters

These ship inside `@plumbus/voice` with no extra packages:

| Kind | Providers | Notes |
|---|---|---|
| Transport | `websocket` | raw app websocket; push-to-talk or continuous |
| STT | `web-speech` | browser client STT (treat transcripts as untrusted) |
| TTS | `browser-tts` | browser client TTS; zero server credentials |

## Optional provider add-ons

Cloud/vendor adapters (including OpenAI) ship as separate packages. Install the add-on, pass its `*_REGISTRATION` into `createProviderRegistry()`, and pass that registry to routes/workers. Install alone does **not** register. CLI/workers also need `app/voice/registry.ts` exporting `voiceProviderRegistry`. See [upgrading-voice-provider-packages.md](../upgrading-voice-provider-packages.md) (agent checklist at the top).

| Kind | Provider id | Install | Notes |
|---|---|---|---|
| Transport | `livekit` | `@plumbus/voice-livekit` | managed rooms / agent worker / browser session |
| STT | `openai-whisper` / `openai-realtime` | `@plumbus/voice-openai` | batch Whisper + streaming Realtime STT |
| TTS | `openai` | `@plumbus/voice-openai` | server TTS (pace-only tone) |
| STT | `soniox` | `@plumbus/voice-soniox` | multilingual streaming STT |
| TTS | `soniox` | `@plumbus/voice-soniox` | REST streaming TTS (`pcm_s16le` @ 16 kHz); same package as STT |
| TTS | `deepdub` | `@plumbus/voice-deepdub` | streaming server TTS |
| TTS | `minimax` | `@plumbus/voice-minimax` | richer delivery-axis mapping; maps `base_resp` API errors; validates audio enums; optional `textNormalization` / `forceCbr` / `voiceModify`; catalog includes system/cloned/generated voices |
| TTS | `elevenlabs` | `@plumbus/voice-elevenlabs` | flash + v3 via official SDK |

## How to choose

| Decision | Recommendation |
|---|---|
| Need the simplest default | start with `websocket` |
| Already standardized on LiveKit | install `@plumbus/voice-livekit` and use `livekit` transport |
| Need browser-only prototype | `web-speech` + `browser-tts` |
| Need authoritative transcripts | use a server STT provider (`soniox` or `openai-whisper`) |
| Need better TTS tone control | evaluate `deepdub`, `minimax`, or `elevenlabs` per locale/latency constraints |

## Catalog API

Two catalog entry points power admin tooling:

- `listVoiceProviderCatalog()` — static catalog (includes add-on descriptors even when packages are not installed)
- `fetchVoiceProviderOptions(...)` — optional live model/voice discovery with cache fallback

The HTTP layer exposes matching admin routes under `/api/voice/catalog*`.

Typical use:

- setup UI lists all supported providers from the static catalog
- admin drills into a provider to fetch voices/models from the live provider API
- UI stores only the chosen provider/model/voice ids in app config

`validateVoiceProviders({ voices, providers, registry })` reports an issue with `field: 'package'` when a voice references an add-on provider that is not installed or not loaded into `registry`. When the package is present but failed to import (for example a missing LiveKit native binding), factory/HTTP errors include `metadata.loadError` / `voice.provider_package_load_failed` instead of a misleading “run pnpm add” hint.

## Custom provider registration

Use `createProviderRegistry()` when you need to add or override registrations.

```ts
import { createProviderRegistry } from '@plumbus/voice';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '@plumbus/voice-livekit';

const registry = createProviderRegistry({
  transport: {
    livekit: LIVEKIT_TRANSPORT_REGISTRATION,
  },
  tts: {
    myProvider: {
      descriptor,
      create(credentials, voiceSlice) {
        return new MyTtsProvider(credentials, voiceSlice);
      },
    },
  },
});
```

Keep custom adapters narrow:

- transport owns realtime session mechanics
- STT owns transcript acquisition
- TTS owns tone mapping and synthesis

Do not move app business logic into provider classes. Add-on authors should import shared types and kit helpers from `@plumbus/voice/provider-kit`, and own their vendor descriptors, static models, and pricing constants inside the add-on package.

## Related docs

- [transports.md](./transports.md)
- [design/providers.md](./design/providers.md)
- [local-providers.md](./local-providers.md)
- [upgrading-voice-provider-packages.md](../upgrading-voice-provider-packages.md)
