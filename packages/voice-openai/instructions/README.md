# @plumbus/voice-openai — Agent Instructions

**After `pnpm add @plumbus/voice-openai`, open this file first:**

`node_modules/@plumbus/voice-openai/instructions/README.md`

| File | When to read | Exact consumer path |
|---|---|---|
| [framework.md](./framework.md) | Install, peers, registration, env vars | `node_modules/@plumbus/voice-openai/instructions/framework.md` |

Parent voice recipes: `node_modules/@plumbus/voice/instructions/README.md`

Package overview: [../README.md](../README.md). Conceptual voice docs: `docs/voice/`.

## Critical rules

- **Install for OpenAI voice providers** — `stt.provider: 'openai-whisper' | 'openai-realtime'` and/or `tts.provider: 'openai'`. Do not use this package for Soniox, Deepdub, ElevenLabs, MiniMax, or LiveKit.
- **Register explicitly** with `createProviderRegistry({ stt/tts })` for each `*_REGISTRATION` you need and pass that registry to routes/workers. Install alone does **not** register providers.
- **Import kit types/helpers from `@plumbus/voice/provider-kit`**, not deep voice paths.
- **Business logic stays in `brain.run` / capabilities** — this package is an STT/TTS adapter only.
- **Require `OPENAI_API_KEY`** at runtime (or bridge via `resolveVoiceOpenAICredentials` from Plumbus AI config).
