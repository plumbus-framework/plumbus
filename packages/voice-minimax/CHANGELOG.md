# Changelog

## 0.1.1

### Fixed

- Attach `MINIMAX_VOICE_PRICING` on `MINIMAX_TTS_REGISTRATION.pricing` for ledger USD via `createProviderRegistry()`.
- Surface MiniMax API errors from `base_resp.status_code` (HTTP SSE, WebSocket, and `get_voice`) instead of treating HTTP 200 as success.
- Honor WebSocket `task_failed` and `is_final` termination signals.
- Include `voice_generation` voices from `POST /v1/get_voice` (`voice_type: all`) in `listVoices`.
- Play only HTTP SSE chunks with `data.status === 1` (skip status-2 aggregated/metadata audio).
- Prefer MiniMax `extra_info.usage_characters` for cost quantity when the final chunk provides it.
- Include `trace_id` in MiniMax `PlumbusError` metadata when present.
- Reject unsupported streaming `wav` audio format up front.
- Append optional `GroupId` query param from `credentials.options.groupId` / `MINIMAX_GROUP_ID`.
- Parse HTTP SSE with `eventsource-parser` (spec-complete framing; incomplete trailing frames without a blank line are dropped).
- Map MiniMax `base_resp.status_code` to `Unauthorized` / `Validation` / rate-limit metadata (`category`).
- Validate streaming `format`, `sampleRate`, `channel`, and mp3 `bitrate` against MiniMax enums before request.
- Passthrough optional `tts.options.textNormalization`, `forceCbr`, and `voiceModify` (`pitch` / `intensity` / `timbre` / `soundEffects`).

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
