# Voice provider design

`@plumbus/voice` treats transport, STT, and TTS as independently swappable providers. Apps choose provider ids in `defineVoice`; the runtime wires them through a shared registry and factory.

## Capability model

Each built-in provider exports a `ProviderDescriptor` with:

- `execution`: `server` or `client`
- `streaming`: whether sentence chunking + streaming synthesis applies
- `toneSupport` and `deliveryMode`: how `resolveTone()` maps into vendor params

Server providers must implement real vendor wire protocols (HTTP or WebSocket). Client providers (`web-speech`, `browser-tts`) relay browser capabilities through the same event protocol.

## Per-adapter tone translation

Apps never pass vendor-native params in `defineVoice`. They return `ToneProfileId | DeliveryTone` from `resolveTone()`, and each TTS adapter implements `mapDeliveryTone()` internally.

| Provider | Mapping |
|---|---|
| `deepdub` | `tempo`, `variance`, `temperature`, `promptBoost` |
| `openai` | `speed` from `pace` only |
| `minimax` | `speed`, `pitch`, `vol`, `emotion`, `language_boost` |
| `elevenlabs` flash | native params only |
| `elevenlabs` v3 | `inline-text-tags` via `applyDeliveryToText()` |

## ElevenLabs dual-model delivery

| Model | Hebrew | Streaming | Delivery mode |
|---|---|---|---|
| `eleven_flash_v2_5` | no | yes (`textToSpeech.stream`) | `native-params` |
| `eleven_v3` | yes | yes (`textToSpeech.stream`) | `inline-text-tags` |

Both models synthesize through the official `@elevenlabs/elevenlabs-js` SDK (`client.textToSpeech.stream()`). Use flash for low-latency English stacks. Use v3 when Hebrew quality matters.

## Optional provider add-ons

Cloud STT/TTS/transport vendors ship as separate `@plumbus/voice-*` packages. Install the add-on, then register it explicitly — e.g. `createProviderRegistry({ transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION } })` — and pass that registry to `registerVoiceRoutes` / workers. There is no install-time auto-registration.

| Package | Provider id | Kind |
|---|---|---|
| `@plumbus/voice-openai` | `openai-whisper` / `openai-realtime` / `openai` | stt + tts |
| `@plumbus/voice-livekit` | `livekit` | transport (+ agent worker / `./client` session) |
| `@plumbus/voice-soniox` | `soniox` | stt |
| `@plumbus/voice-deepdub` | `deepdub` | tts |
| `@plumbus/voice-elevenlabs` | `elevenlabs` | tts |
| `@plumbus/voice-minimax` | `minimax` | tts |

## Adding a vendor

1. Prefer a new `@plumbus/voice-<vendor>` package that exports `*_REGISTRATION` and imports kit helpers from `@plumbus/voice/provider-kit`.
2. Register it via `createProviderRegistry({ … })` in app bootstrap and `app/voice/registry.ts` for CLI/workers.
3. Add descriptor metadata + pricing entry in the add-on package (not inside `@plumbus/voice`).
4. Add fixture-based wire tests (no live network in default CI).
5. Document credential fields in `docs/voice/configuration.md`.

MiniMax is the reference TTS adapter for full delivery-axis support. OpenAI TTS (`@plumbus/voice-openai`) is the reference `pace-only` adapter. LiveKit is the reference transport add-on (`@plumbus/voice-livekit`).
