# @plumbus/voice-elevenlabs — Agent Instructions

**After `pnpm add @plumbus/voice-elevenlabs`, open this file first:**

`node_modules/@plumbus/voice-elevenlabs/instructions/README.md`

| File | When to read | Exact consumer path |
|---|---|---|
| [framework.md](./framework.md) | Install, peers, registration, env vars | `node_modules/@plumbus/voice-elevenlabs/instructions/framework.md` |

Parent voice recipes: `node_modules/@plumbus/voice/instructions/README.md`

Package overview: [../README.md](../README.md). Conceptual voice docs: `docs/voice/`.

## Critical rules

- **Install only for `tts.provider: 'elevenlabs'`** — do not use this package for OpenAI/browser/Deepdub/MiniMax TTS.
- **Register explicitly** with `createProviderRegistry({ tts: { elevenlabs: ELEVENLABS_TTS_REGISTRATION } })` and pass that registry to routes/workers. Install alone does **not** register the provider.
- **`eleven_flash_*` does not support Hebrew** — use `eleven_v3`, Deepdub, or MiniMax for `he-*` locales.
- **Import kit helpers from `@plumbus/voice/provider-kit`**. Export `createElevenLabsCapabilities` / `ELEVENLABS_TTS_DESCRIPTOR` from this package.
- **Business logic stays in `brain.run` / capabilities** — this package is a TTS adapter only.
