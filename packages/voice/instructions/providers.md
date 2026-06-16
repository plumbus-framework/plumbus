# Picking Voice Providers — Agent Recipe

Use this when the user asks which transport/STT/TTS stack to choose.

## Decision order

1. **Transport first**: `websocket` vs `livekit`
2. **STT next**: client (`web-speech`) vs server (`soniox`, `openai-whisper`, `openai-realtime`)
3. **TTS last**: browser (`browser-tts`) vs cloud/server (`openai`, `deepdub`, `minimax`, `elevenlabs`)

## Fast defaults

| Constraint | Suggested choice |
|---|---|
| Browser-first prototype | `websocket` + `web-speech` + `browser-tts` |
| Server-owned STT, simple infra | `websocket` + `openai-whisper` + chosen TTS |
| Room/media infra already standardized on LiveKit | `livekit` + server STT/TTS stack |
| Hebrew-focused production TTS | evaluate `minimax`, `deepdub`, and `elevenlabs v3` tradeoffs explicitly |

## Catalog API

If the user needs an admin/provider picker UI, use:

- `listVoiceProviderCatalog()`
- `fetchVoiceProviderOptions(...)`
- guarded HTTP catalog routes under `/api/voice/catalog*`

## Custom providers

Only add a custom provider registration when the wire protocol or auth model actually differs from the built-ins. If the request is only "use a different OpenAI-compatible base URL", reuse the existing adapter.

## Deeper reference

- `/docs/voice/providers.md`
- `/docs/voice/transports.md`
- `/docs/voice/design/providers.md`
