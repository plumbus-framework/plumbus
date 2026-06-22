# Changelog

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
