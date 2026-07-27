# Changelog

## 0.1.1

### Fixed

- Attach `MINIMAX_VOICE_PRICING` on `MINIMAX_TTS_REGISTRATION.pricing` for ledger USD via `createProviderRegistry()`.

## 0.1.0

### Added

- Initial extraction of the MiniMax TTS provider from `@plumbus/voice` 0.3.0.
- Export: `MINIMAX_TTS_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Required env / credentials: `MINIMAX_API_KEY` (`apiKey`); optional `baseUrl` (default `https://api.minimax.io`).

### Fixed

- Warmth maps to integer MiniMax pitch semitones (`low→-2`, `medium→0`, `high→2`); pitch is clamped/rounded to `[-12, 12]`.
- `whisper` / `fluent` emotions are only sent for `speech-2.6-*` models; speech-2.8 drops them.
- `listVoices` uses `POST /v1/get_voice` with `{ "voice_type": "all" }` and concatenates `system_voice` + `voice_cloning` (maps `voice_name` → `displayName`).
- Default `audio_setting` is mono `pcm` at 16 kHz (matches `@plumbus/voice` PCM pipeline / `pcm16-16k`); bitrate is omitted unless `format` is `mp3`.
