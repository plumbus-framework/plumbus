# @plumbus/voice-minimax — Agent Instructions

**After `pnpm add @plumbus/voice-minimax`, open this file first:**

`node_modules/@plumbus/voice-minimax/instructions/README.md`

| File | When to read | Exact consumer path |
|---|---|---|
| [framework.md](./framework.md) | Install, peers, registration, env vars | `node_modules/@plumbus/voice-minimax/instructions/framework.md` |

Parent voice recipes: `node_modules/@plumbus/voice/instructions/README.md`

Package overview: [../README.md](../README.md). Conceptual voice docs: `docs/voice/`.

## Critical rules

- **Install only for `tts.provider: 'minimax'`** — do not use this package for OpenAI/browser/Deepdub/ElevenLabs TTS.
- **Register explicitly** with `createProviderRegistry({ tts: { minimax: MINIMAX_TTS_REGISTRATION } })` and pass that registry to routes/workers. Install alone does **not** register the provider.
- **Import kit types/helpers from `@plumbus/voice/provider-kit`**, not deep voice paths.
- **Business logic stays in `brain.run` / capabilities** — this package is a TTS adapter only.
- **Require `MINIMAX_API_KEY`** at runtime for synthesis and live voice listing.
- **Default audio is PCM 16 kHz mono** — matches the voice transport PCM pipeline; set `tts.options.sampleRate` if the LiveKit output rate should differ.
