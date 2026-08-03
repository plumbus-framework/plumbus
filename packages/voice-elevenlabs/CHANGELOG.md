# Changelog

## 0.1.1

### Fixed

- Attach `ELEVENLABS_VOICE_PRICING` on `ELEVENLABS_TTS_REGISTRATION.pricing` for ledger USD via `createProviderRegistry()`.

## 0.1.0

### Added

- Initial extraction of the ElevenLabs TTS provider from `@plumbus/voice` 0.3.0.
- Export: `ELEVENLABS_TTS_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Official SDK integration via `@elevenlabs/elevenlabs-js` (`client.textToSpeech.stream()` for both flash and v3).
- Injectable `credentials.options.elevenLabsClientFactory` for tests and custom clients (lazy SDK import when unset).
- Required env / credentials: `ELEVENLABS_API_KEY` (`apiKey`).

### Changed

- Flash and v3 synthesis both use the SDK streaming API; the hand-rolled WebSocket flash path is removed.
- Catalog descriptor reports `streaming: true` for all ElevenLabs models (including `eleven_v3`).

### Removed

- `chunkLengthSchedule` voice option support (no SDK equivalent on `textToSpeech.stream()`).
- Direct `fetch` / WebSocket wire helpers for ElevenLabs TTS.
