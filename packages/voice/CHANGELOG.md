# Changelog

## 0.4.4

### Added

- **Backchannel continuers** — opt-in via `stt.options.backchannelEnabled` (default `false`). Same knobs as 0.2.0 / 0.4.3: `backchannelPauseMs` (default 900), `backchannelMinTranscriptChars` (default 40), `backchannelCooldownMs` (default 6000), `backchannelPhrases` (flat array or `{ he, en, default }` map). Audio-only: no `assistant.delta`, no `Playing`. Resume speech, endpoint grace, an in-flight turn/repair, `dispose()`, and transport loss all abort or suppress the continuer. Isolated one-syllable particles can be mangled by TTS providers — prefer multi-character phrases in the pool. Cost rows use `voice.backchannel`.
- **`DeliveryTone.voiceId`** — optional per-turn voice override carried through tone profiles and `resolveTone` results to the TTS adapter's `mapDeliveryTone`. Enables emotional style-variant switching on providers whose voices ship as per-register style prompts of the same speaker (see `@plumbus/voice-deepdub` 0.1.3). Providers without per-call voice selection ignore it.
- **Sentence-chunker micro-fragment merging** — the streaming turn pipeline always merges chunks shorter than 8 characters into the following sentence instead of synthesizing them as an isolated, contextless call. A leading hesitation like "המממ..." synthesized alone is read as disconnected syllables; merged into its sentence it reads naturally. This unblocks generation-time written hesitations in voice replies. There is no `defineVoice` / `tts.options` knob (`minChunkChars` exists only on the internal `createSentenceChunker()` helper used by tests). Short first sentences (`כן.`, `Yes.`) wait for the next sentence; that delay is intended.

### Fixed

- **The live transcript mirror shows stitched speech** — when resumed speech is stitched onto a deferred pre-pause fragment (grace window or in-flight queue), the emitted `stt.partial`/`stt.final` events now carry the full stitched text instead of the bare resumed fragment. Previously the client's transcript mirror silently dropped the pre-pause speech until the turn committed, making long answers appear to vanish.
- **In-flight speech is re-queued, not dropped** (server-STT continuous mode; the web-speech client mode is unchanged) — an utterance whose endpoint fires while a brain turn or hearing-repair prompt is still in flight is kept pending and its endpoint is replayed through the normal grace window once the in-flight work settles. Multiple utterances queued during one turn are stitched in order. Previously the `turnInFlight` guard silently swallowed the turn trigger and the next utterance overwrote the pending transcript (crossed-thread / lost-answer behavior in continuous sessions). The replay never fires while a cumulative utterance is still open (its own endpoint delivers the stitched transcript — replaying mid-utterance would duplicate the overlap) and never after `dispose()`/transport loss (no post-teardown ghost turns). Barge-in discards speech queued before the interrupt; speech arriving after it still becomes the next turn.
- **Session lifecycle hardening** — `dispose()` now gates late STT callbacks (a suspended endpoint chain settling after teardown no longer starts a ghost turn) and clears the pending transcript; `notifyTransportLost()` uses the same `#disposed` gate (and clears pending) so a late endpoint, a newly armed silence timer, or a repair/turn `finally` that already captured the queued flag cannot start a ghost turn into a dead transport, and also disarms any already-armed grace/failsafe timers; barge-in now also cancels a turn waiting in the endpoint grace window (previously a no-op unless a turn was already in flight); grace/failsafe timer rejections are contained instead of becoming unhandled rejections; an empty `stt.final` control frame no longer clobbers a pending transcript; the silence-failsafe queue no longer snapshots a still-open cumulative utterance (word duplication); and the speech-energy gate now reads post-gain audio, so `enableInputNormalization` speakers get hearing repair instead of being silently below the threshold.
- **The JS linear resampler warns when it engages** — it has no anti-alias filter, so a live-path resample is silent quality loss; it now logs loudly (once per rate pair) with guidance to align the transport audio format with the STT format instead.
- **Endpoint-grace stitching survives cumulative partials** — the deferred pre-pause fragment is re-prefixed on every server STT partial instead of being consumed by the first one, so resumed speech that produces more than one partial event (all real server providers) no longer clobbers the words spoken before the pause.

## 0.4.3

### Added

- **Voice cloning** — `ClonedVoice` / `VoiceCloneProvider` types; `TTSProviderRegistration.clone`; `createVoiceCloneProvider`, `supportsVoiceCloning`, `synthesizeWithVoiceReference`; ownership-aware `registerVoiceCloneRoutes` (create-persist rollback, `listOwnedClones`, optional `referenceAccess` for instant-reference preview).
- **`VoiceUsageKind`** includes `'clone'` for persist create/delete usage records.

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
