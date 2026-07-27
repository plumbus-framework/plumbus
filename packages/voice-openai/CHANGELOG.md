# Changelog

## 0.1.1

### Fixed

- Attach `OPENAI_VOICE_PRICING` rows on Whisper / Realtime / TTS registrations so `createProviderRegistry()` seeds ledger USD.

## 0.1.0

### Added

- Initial extraction of OpenAI Whisper STT, OpenAI Realtime STT, and OpenAI TTS providers from `@plumbus/voice` 0.3.0.
- Exports: `OPENAI_WHISPER_STT_REGISTRATION`, `OPENAI_REALTIME_STT_REGISTRATION`, `OPENAI_TTS_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Required env / credentials: `OPENAI_API_KEY` (`apiKey`); optional `OPENAI_BASE_URL`.
