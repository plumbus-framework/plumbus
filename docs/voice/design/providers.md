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
| `eleven_flash_v2_5` | no | yes (WebSocket) | `native-params` |
| `eleven_v3` | yes | no (HTTP) | `inline-text-tags` |

Use flash for low-latency English stacks. Use v3 when Hebrew quality matters and latency is acceptable.

## Adding a vendor

1. Implement `STTProvider`, `TTSProvider`, or `TransportProvider` in `src/providers/`.
2. Register it in `createProviderRegistry()`.
3. Add descriptor metadata + pricing entry in `voice-pricing.ts`.
4. Add fixture-based wire tests (no live network in default CI).
5. Document credential fields in `docs/voice/configuration.md`.

MiniMax is the reference TTS adapter for full delivery-axis support. OpenAI TTS is the reference `pace-only` adapter.
