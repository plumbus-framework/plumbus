# @plumbus/voice-soniox — Agent Instructions

**After `pnpm add @plumbus/voice-soniox`, open this file first:**

`node_modules/@plumbus/voice-soniox/instructions/README.md`

| File | When to read | Exact consumer path |
|---|---|---|
| [framework.md](./framework.md) | Install, peers, registration, env vars | `node_modules/@plumbus/voice-soniox/instructions/framework.md` |

Parent voice recipes: `node_modules/@plumbus/voice/instructions/README.md`

Package overview: [../README.md](../README.md). Conceptual voice docs: `docs/voice/`.

## Critical rules

- **Install only for `stt.provider: 'soniox'`** — do not use this package for builtin `web-speech` or OpenAI STT (`@plumbus/voice-openai`).
- **Register explicitly** with `createProviderRegistry({ stt: { soniox: SONIOX_STT_REGISTRATION } })` and pass that registry to routes/workers. Install alone does **not** register the provider.
- **Import kit types/helpers from `@plumbus/voice/provider-kit`**, not deep voice paths.
- **Business logic stays in `brain.run` / capabilities** — this package is an STT adapter only.
- **Require `SONIOX_API_KEY`** at runtime for streaming transcription.
