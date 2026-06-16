# Changelog

## 0.1.0

### Added

- Dvora/LiveKit gaps: `beforeSession.livekit` token minting, `mintLiveKitParticipantToken`, `joinVoiceRoomSession`, `startVoiceAgentWorker`, streaming brain+TTS pipeline, Soniox endpoint detection and `context.terms`, Deepdub multiplex WS with abort/barge-in, `plumbus voice worker`, `createLiveKitVoiceSession` client helper (16 kHz PCM16 capture + PTT data), and `docs/voice/dvora-integration.md`.

### Added (initial)

- `@plumbus/voice` realtime voice runtime: `defineVoice`, `runVoiceTurn`, `registerVoiceRoutes`, `startVoiceWorker`.
- Provider registry with Soniox, OpenAI Whisper/Realtime/TTS, Deepdub, MiniMax, ElevenLabs, browser/web-speech client adapters, LiveKit and WebSocket transport.
- Cost ledger integration via `recordVoiceCost`, session budgets, and `ctx.ai.checkProviderCostBudget` pre-checks.
- Catalog/admin routes, client browser helpers (`@plumbus/voice/client`), smoke and e2e test suite, quality harness script.
- `resolveVoiceOpenAICredentials` helper bridging Plumbus AI bootstrap config to voice OpenAI adapters.
