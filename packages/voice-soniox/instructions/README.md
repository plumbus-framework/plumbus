# @plumbus/voice-soniox — Agent Instructions

**After `pnpm add @plumbus/voice-soniox`, open this file first:**

`node_modules/@plumbus/voice-soniox/instructions/README.md`

| File | When to read | Exact consumer path |
|---|---|---|
| [framework.md](./framework.md) | Install, peers, registration, env vars | `node_modules/@plumbus/voice-soniox/instructions/framework.md` |

Parent voice recipes: `node_modules/@plumbus/voice/instructions/README.md`

Package overview: [../README.md](../README.md). Conceptual voice docs: `docs/voice/`.

## Critical rules

- **Install for `stt.provider: 'soniox'` and/or `tts.provider: 'soniox'`** — do not use this package for builtin `web-speech` / `browser-tts` or OpenAI STT/TTS (`@plumbus/voice-openai`).
- **Register explicitly** — STT: `createProviderRegistry({ stt: { soniox: SONIOX_STT_REGISTRATION } })`; TTS: `tts: { soniox: SONIOX_TTS_REGISTRATION }`. Install alone does **not** register.
- **Import kit types/helpers from `@plumbus/voice/provider-kit`**, not deep voice paths.
- **Business logic stays in `brain.run` / capabilities** — this package adapts Soniox's SDK to voice STT/TTS contracts.
- **Require `SONIOX_API_KEY`** at runtime for Soniox STT and/or TTS.
- **Voice cloning** — UUID `voice` ids are clones; use `createVoiceCloneProvider` / `waitUntilReady`. Requires `@soniox/node` ^2.2.0. See `docs/voice/voice-cloning.md`.
