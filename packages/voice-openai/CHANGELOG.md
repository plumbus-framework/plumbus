# Changelog

## 0.1.3

### Changed

- Realtime streaming STT now uses the official SDK client (`OpenAIRealtimeWS` from `openai/realtime/ws`) instead of a hand-rolled WebSocket.
- Connection URL model defaults to `gpt-realtime` (override with `stt.options.realtimeConnectionModel`); transcription model remains `stt.model` (default `gpt-realtime-whisper`).
- Custom Realtime bases: credential `baseUrl` / `OPENAI_BASE_URL` (HTTP or `ws`/`wss`) are normalized to HTTP(S) for the SDK, which upgrades to `wss`.
- Depends on `ws` (OpenAI Realtime peer) so the Node Realtime client works at runtime.

## 0.1.2

### Changed

- Whisper STT and OpenAI TTS now call the official [`openai`](https://www.npmjs.com/package/openai) SDK (`audio.transcriptions` / `audio.speech`) instead of hand-rolled `fetch`.
- Custom / third-party OpenAI-compatible endpoints still work via credential `baseUrl` / `OPENAI_BASE_URL` (passed as SDK `baseURL`).
- Apps must **not** import `openai` directly — this package owns the SDK boundary (same pattern as `@deepdub/node` / `@soniox/node`).

## 0.1.1

### Fixed

- Attach `OPENAI_VOICE_PRICING` rows on Whisper / Realtime / TTS registrations so `createProviderRegistry()` seeds ledger USD.

## 0.1.0

### Added

- Initial extraction of OpenAI Whisper STT, OpenAI Realtime STT, and OpenAI TTS providers from `@plumbus/voice` 0.3.0.
- Exports: `OPENAI_WHISPER_STT_REGISTRATION`, `OPENAI_REALTIME_STT_REGISTRATION`, `OPENAI_TTS_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Required env / credentials: `OPENAI_API_KEY` (`apiKey`); optional `OPENAI_BASE_URL`.
