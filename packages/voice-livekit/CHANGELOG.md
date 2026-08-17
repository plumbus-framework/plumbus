# Changelog

## 0.1.3

### Changed

- **Mic capture tuned for STT input.** `micConstraintsForNoiseCancellation` now explicitly sets `voiceIsolation: false` (livekit-client defaults it to true — a hidden extra enhancement stage in front of STT input); the mic publish disables Opus DTX (silence suppression can swallow quiet speakers' soft speech onsets) and enables RED for loss resilience.

### Fixed

- **`parsePcmFormat` understands short-form audio formats** (`pcm16-16k` / `pcm16-24k` / `pcm16-48k`) in the agent worker instead of silently defaulting to 16 kHz — which was correct only by coincidence for `pcm16-16k`.


## 0.1.2

### Fixed

- Attach `LIVEKIT_VOICE_PRICING` on `LIVEKIT_TRANSPORT_REGISTRATION.pricing` so registry bootstrap seeds transport rates (transport recording still passes an explicit `cost` override).

## 0.1.1

### Fixed

- **Browser client bundle:** `./client` no longer imports `@plumbus/core` or `@plumbus/voice` package roots. Uses `@plumbus/core/errors` and `@plumbus/voice/noise-cancellation` so Next/Turbopack client builds do not pull CLI/drizzle/`node:fs` into the browser graph.

## 0.1.0

### Added

- Initial extraction of LiveKit transport, agent worker, noise cancellation, room join helpers, and browser session helpers from `@plumbus/voice` 0.3.0.
- Package entry points: `.`, `./client`, and `./worker`.
- Exports: `LIVEKIT_TRANSPORT_REGISTRATION` (with `toClientSessionPayload`), `mintLiveKitParticipantToken`, `startVoiceAgentWorker`, `joinVoiceRoomSession`, `startVoiceWorker`, `createVoiceAgentEntry`, `createInboundAudioStream`, `resolveAgentNoiseCancellationOption`, `createLiveKitVoiceSession`, `applyClientNoiseCancellation`, and related helpers.
- Workers require an explicit `registry` (from app bootstrap / `app/voice/registry.ts`). Omitting it throws — there is no soft-load fallback.
- An explicit registry that omits `transport.livekit` is rejected — workers do **not** silently inject `LIVEKIT_TRANSPORT_REGISTRATION`.
- LiveKit-named client helpers (`parseLiveKitVoiceDataPayload`, track/audio helpers) and worker contracts (`ConnectLiveKitWorkerArgs`, `StartVoiceAgentWorkerOptions`, …) live on this package (`./client` and `.`), not `@plumbus/voice` / provider-kit.
- Required env / credentials: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
- Optional browser peers: `livekit-client`, `@livekit/krisp-noise-filter`.
