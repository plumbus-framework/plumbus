# Changelog

## 0.4.2

### Added

- **`registerVoicePricing()` / `resetRegisteredVoicePricing()`** — add-on pricing rows feed `lookupVoicePricing` / `calculateVoiceCost`. `createProviderRegistry()` auto-registers each `*_REGISTRATION.pricing` field so Soniox/Deepdub/etc. ledger USD is non-null after the provider-package split (without requiring a LiveKit-style `cost` override on every STT/TTS record).

## 0.4.1

### Added

- **`@plumbus/voice/noise-cancellation`** — thin browser-safe export of noise-cancellation enums/types (`NoiseCancellationPlacement`, `SerializedNoiseCancellation`, …). `@plumbus/voice-livekit/client` must import these from this subpath (or keep them type-only), not from `@plumbus/voice` — the package root pulls server runtime + `@plumbus/core` CLI into the Next client graph.

## 0.4.0

### Changed

- **Breaking:** `deepdub`, `soniox`, `elevenlabs`, `minimax`, and `livekit` ship as separate `@plumbus/voice-*` packages. They are **not** auto-registered — apps must pass each package’s `*_REGISTRATION` into `createProviderRegistry({ stt/tts/transport })` and pass that registry to routes/workers. `@plumbus/voice` does **not** peer-depend on the add-ons.
- **Breaking (imports):** LiveKit session/agent APIs moved to `@plumbus/voice-livekit` / `./client` (`createLiveKitVoiceSession`, `applyClientNoiseCancellation`, `createVoiceAgentEntry`, `createInboundAudioStream`, `resolveAgentNoiseCancellationOption`, `startVoiceAgentWorker`, `joinVoiceRoomSession`, `startVoiceWorker`, `mintLiveKitParticipantToken`, bootstrap helpers).
- **Breaking:** `beforeSession.livekit` → `beforeSession.room`. `POST /api/voice/:name/token` is transport-agnostic (any minting transport; websocket still uses `/session`). Session tokens accept any non-empty `voice_transport` string (no hard-coded `livekit` allow-list).
- Dropped vendor runtime dependencies from `@plumbus/voice` (`@deepdub/node`, `@soniox/node`, `@livekit/*`, `@shiguredo/rnnoise-wasm`, `livekit-server-sdk`, `livekit-client` peers).
- The ElevenLabs provider moved to `@plumbus/voice-elevenlabs` and uses `@elevenlabs/elevenlabs-js` (`textToSpeech.stream()`). The hand-rolled flash WebSocket path and `chunkLengthSchedule` are gone.
- `fetchCatalogJson` / `VoiceCatalogFetch` accept an optional request `body` for POST catalog endpoints (e.g. MiniMax `POST /v1/get_voice`).
- `normalizeVoiceList` maps provider `voice_name` fields to `displayName`.

### Added

- `@plumbus/voice/provider-kit` subpath for provider add-on authors.
- `loadAppVoiceRegistry()` — loads `app/voice/registry.ts` (`voiceProviderRegistry` + optional `voiceProviders`) for CLI/workers.
- `TransportProviderRegistration.toClientSessionPayload` for transport-agnostic `/token` responses.
- Public export needed by add-ons: `VoiceSessionController`, `recordVoiceCost` (optional `cost` override for add-on pricing).

### Removed

- `loadVoiceAddons()`, `VOICE_ADDON_PACKAGES`, `voiceAddonMissingHint`, `createRegistryForVoices`, `resolveAddonCredentialsFromEnv`, and all soft-load / install-hint maps.
- OpenAI STT/TTS (now `@plumbus/voice-openai`) plus all other cloud/vendor descriptors, models, and pricing.
- LiveKit-named types/helpers from `@plumbus/voice` / provider-kit / client.
- Dead `src/runtime/worker-cli.ts` (superseded by `plumbus voice worker`).

See [docs/upgrading-voice-provider-packages.md](../../docs/upgrading-voice-provider-packages.md).

## 0.3.0

### Added

- LiveKit noise cancellation matrix on `transport.options.noiseCancellation`:
  - **Client Krisp** via `@livekit/krisp-noise-filter` (`placement: 'client'`)
  - **Agent Krisp** via `@livekit/noise-cancellation-node` (`placement: 'agent'`)
  - **OSS agent/client RNNoise** via `@shiguredo/rnnoise-wasm`
  - **OSS agent DTLN** scaffold (requires `onnxruntime-node` + model dir / `PLUMBUS_DTLN_MODEL_DIR`)
- Token route exposes `noiseCancellation` for browser client auto-wiring in `createLiveKitVoiceSession()`
- Helpers: `parseNoiseCancellation`, `createInboundAudioStream`, `applyClientNoiseCancellation`
- Docs: [`instructions/noise-cancellation.md`](./instructions/noise-cancellation.md)

### Fixed

- `@plumbus/voice/client` keeps browser NC in `client-noise-cancellation.ts` so Next.js/Turbopack never bundles agent-only deps (`@livekit/rtc-node`, `@plumbus/core` CLI, etc.)

## 0.2.0

### Changed

- STT providers can declare `capabilities.endpointDetection`. When a provider (e.g. Soniox) sets it and endpoint detection is enabled, the continuous-session controller drives turns purely from the provider's `onEndpoint` signal and no longer schedules its silence-timer failsafe. Apps can re-enable the failsafe with a positive `stt.options.endpointSilenceMs`.
- Soniox STT maps `stt.options.endpointSensitivity` to the SDK's `endpoint_sensitivity` field.
- `VoiceSessionController` supports `stt.options.endpointGraceMs` to defer endpoint-triggered turns; resumed speech within the grace window cancels the pending turn and is stitched onto the deferred utterance.
- Optional `stt.options.backchannelEnabled` emits audio-only continuers during reflective pauses without a brain turn; tuned via `backchannelPauseMs`, `backchannelMinTranscriptChars`, `backchannelCooldownMs`, and `backchannelPhrases` (flat array or `{ he, en, default }` map). `speakDirectUtterance` accepts `emitAssistantText` and `announcePlaying` (default `true`) for audio-only backchannels.

### Fixed

- Soniox STT now treats the in-stream `<end>` control token as the authoritative end-of-speech signal (in addition to the SDK's derived `endpoint` event), so turns fire on Soniox's own boundary instead of falling back to the controller's silence-timer failsafe. Endpoint is de-duplicated per utterance.
- Hebrew STT regression test locks in Soniox token spacing across streamed final/pending tokens (no collapsed inter-word spaces).
- Deepdub TTS reconnects once when its WebSocket drops before `generateToBuffer` (stale session after worker/network interruption).
- Grace-window resume no longer drops the first half of an utterance: the controller stitches deferred transcript text onto resumed STT fragments before firing the turn.

### Added

- Backchannel continuers: `stt.options.backchannelEnabled` plus pause/min-chars/cooldown/phrases tuning; phrases may be a flat array or language-keyed map (`{ he: [...], en: [...] }`); audio-only via `speakDirectUtterance({ emitAssistantText: false, announcePlaying: false })`.
- `streaming-turn-pipeline` awaits `onAssistantDelta` so text data frames flush before TTS audio is published.
- Client `tts.speak` control now resolves the voice's delivery tone (including a per-turn `targetGender`) before synthesis, so message replay matches the same voice/gender as live turns.
- `VOICE_STT_DEBUG_TOKENS=true` logs raw Soniox token payloads for STT diagnostics.

## 0.1.0

### Added

- LiveKit continuous voice: `beforeSession.livekit` token minting, `mintLiveKitParticipantToken`, `joinVoiceRoomSession`, `startVoiceAgentWorker`, streaming brain+TTS pipeline, Soniox endpoint detection and `context.terms`, Deepdub multiplex WS with abort/barge-in, `plumbus voice worker`, `createLiveKitVoiceSession` client helper (16 kHz PCM16 capture + PTT data), and `docs/voice/livekit-continuous-voice.md`.

### Added (initial)

- `@plumbus/voice` realtime voice runtime: `defineVoice`, `runVoiceTurn`, `registerVoiceRoutes`, `startVoiceWorker`.
- Provider registry with Soniox, OpenAI Whisper/Realtime/TTS, Deepdub, MiniMax, ElevenLabs, browser/web-speech client adapters, LiveKit and WebSocket transport.
- Cost ledger integration via `recordVoiceCost`, session budgets, and `ctx.ai.checkProviderCostBudget` pre-checks.
- Catalog/admin routes, client browser helpers (`@plumbus/voice/client`), smoke and e2e test suite, quality harness script.
- `resolveVoiceOpenAICredentials` helper bridging Plumbus AI bootstrap config to voice OpenAI adapters.
