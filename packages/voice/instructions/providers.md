# Picking Voice Providers — Agent Recipe

Use this when the user asks which transport/STT/TTS stack to choose.

## Decision order

1. **Transport first**: `websocket` vs `livekit`
2. **STT next**: client (`web-speech`) vs server (`soniox`, `openai-whisper`, `openai-realtime`)
3. **TTS last**: browser (`browser-tts`) vs cloud/server (`openai`, `soniox`, `deepdub`, `minimax`, `elevenlabs`)

## Install matrix — check this before recommending a provider

Only these ids work with `@plumbus/voice` alone: `websocket`, `web-speech`, `browser-tts`.

| Provider id | Kind | Also install |
|---|---|---|
| `openai-whisper` / `openai-realtime` / `openai` | stt / tts | `@plumbus/voice-openai` |
| `livekit` | transport | `@plumbus/voice-livekit` |
| `soniox` | stt / tts | `@plumbus/voice-soniox` |
| `deepdub` | tts | `@plumbus/voice-deepdub` |
| `elevenlabs` | tts | `@plumbus/voice-elevenlabs` |
| `minimax` | tts | `@plumbus/voice-minimax` |

Add-ons peer `@plumbus/voice` `0.4.x` (and `@plumbus/core` `0.6.x`) — copy those literals. They must be **installed and registered** via `*_REGISTRATION` in `createProviderRegistry()`, then that registry passed to routes/workers (and exported from `app/voice/registry.ts` for CLI). Install alone does not register.

## After install — open these exact paths (do not invent wiring)

| Package | Start here |
|---|---|
| `@plumbus/voice` | `node_modules/@plumbus/voice/instructions/README.md` |
| `@plumbus/voice-openai` | `node_modules/@plumbus/voice-openai/instructions/README.md` |
| `@plumbus/voice-livekit` | `node_modules/@plumbus/voice-livekit/instructions/README.md` |
| `@plumbus/voice-soniox` | `node_modules/@plumbus/voice-soniox/instructions/README.md` |
| `@plumbus/voice-deepdub` | `node_modules/@plumbus/voice-deepdub/instructions/README.md` |
| `@plumbus/voice-elevenlabs` | `node_modules/@plumbus/voice-elevenlabs/instructions/README.md` |
| `@plumbus/voice-minimax` | `node_modules/@plumbus/voice-minimax/instructions/README.md` |

Each add-on `instructions/README.md` links `framework.md` (and LiveKit topic files). Run `plumbus init --patch` so `AGENTS.md` / Copilot wiring lists the same paths.

## Fast defaults

| Constraint | Suggested choice |
|---|---|
| Browser-first prototype | `websocket` + `web-speech` + `browser-tts` (no add-ons) |
| Server-owned STT, simple infra | `websocket` + `openai-whisper` (`@plumbus/voice-openai`) + chosen TTS |
| Room/media infra already standardized on LiveKit | `livekit` (+ `@plumbus/voice-livekit`) + server STT/TTS stack |
| Hebrew-focused production TTS | evaluate `minimax`, `deepdub`, and `elevenlabs v3` tradeoffs explicitly (each needs its add-on) |

## Catalog API

If the user needs an admin/provider picker UI, use:

- `listVoiceProviderCatalog(registry)`
- `fetchVoiceProviderOptions(...)`
- guarded HTTP catalog routes under `/api/voice/catalog*`

Pass the same registry you use for routes so add-on descriptors appear.

## Docs

- [`docs/voice/providers.md`](../../../docs/voice/providers.md)
- [`docs/upgrading-voice-provider-packages.md`](../../../docs/upgrading-voice-provider-packages.md)
