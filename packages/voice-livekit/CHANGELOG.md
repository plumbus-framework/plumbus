# Changelog

## 0.3.0-beta.1 — 2026-09-23

Carries 0.2.2 from `main` into the beta family.

- Frame provider PCM into native captures of at most 20 ms in both transports, preserving samples and stream boundaries, so complete-reply audio chunks no longer wedge the LiveKit capture queue.
- Send voice events above 15 KiB through native LiveKit text streams, bounded to 256 KiB, keeping their order with regular data packets and cancelling pending client readers on disconnect. Update the browser and the agent together; configurable transcript limits need `@plumbus/voice` 0.6.0-beta.1.

## 0.3.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.8.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

## 0.2.2 — 2026-09-23

- Frame provider PCM into at most 20 ms native captures in both transports, preserving samples and stream boundaries; prevents complete-reply audio chunks from wedging the LiveKit capture queue.

- Send voice events above 15 KiB through native LiveKit text streams, bounded to 256 KiB. Preserve ordering with regular data packets and cancel pending client readers on disconnect. Update the browser and agent together to `0.2.2` when enabling longer transcripts; configurable transcript limits require `@plumbus/voice@0.5.2`.

## 0.2.1 — 2026-09-10

### Fixed

- Publish the corrected package README without the added “Release family” banner, using normal `latest` publication. Runtime behavior and peer dependencies are unchanged from 0.2.0.

## 0.2.0 — 2026-09-10

### Upgrade boundary

- This release is an explicit minor-line upgrade. Previous caret ranges exclude it; install the coordinated core 0.7.x family and follow the [migration checklist](../../docs/upgrading-security-release.md). Packages publish to npm’s default `latest` dist-tag.

### Fixed

- Room-session shutdown is idempotent: concurrent or repeated `stop()` calls share one cleanup and one cost-recording attempt. Resources are released before awaiting accounting, including when accounting rejects or stalls.
- Failed room connection, track publication, or initial hello releases acquired resources while preserving the startup error. Native transport cleanup attempts every resource even when another close fails.
- The simulated worker integration now runs without credentials in the default suite; added lifecycle failure and concurrency regression tests. Public APIs and pricing remain unchanged.

### Agent instructions

- Updated packaged guidance for the security release and linked the core upgrade checklist. Refresh generated app instructions with `plumbus init --patch` (wiring v16).

### Security

- Include tenant identity in default room names when supplied by the voice runtime. Room resolvers receive optional tenant identity.

### Compatibility

- Explicitly configured room names remain unchanged; callers without a tenant keep their previous naming behavior. Clients should use returned room names, not reconstruct them. App-authorized shared rooms remain supported.
- Deploy with voice 0.5.0 and core 0.7.0 for automatic tenant propagation and the complete security release. [Migration guide](../../docs/upgrading-security-release.md).

## 0.1.4

### Fixed

- **LiveKit transport rate corrected to $0.0005/participant-minute** (was $0.02 — 40× the LiveKit Cloud Ship-tier WebRTC overage rate). Below each plan's included monthly allotment (5k–1.5M participant-minutes) the marginal cost is $0; this records the overage rate. A self-hosted agent joining the room bills as an ordinary participant.

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
