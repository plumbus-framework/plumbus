# @plumbus/voice-deepdub — Agent Instructions

**After `pnpm add @plumbus/voice-deepdub`, open this file first:**

`node_modules/@plumbus/voice-deepdub/instructions/README.md`

| File | When to read | Exact consumer path |
|---|---|---|
| [framework.md](./framework.md) | Install, peers, registration, env vars | `node_modules/@plumbus/voice-deepdub/instructions/framework.md` |

Parent voice recipes: `node_modules/@plumbus/voice/instructions/README.md`

Package overview: [../README.md](../README.md). Conceptual voice docs: `docs/voice/`.

## Critical rules

- **Install only for `tts.provider: 'deepdub'`** — do not use this package for OpenAI/browser/ElevenLabs/MiniMax TTS.
- **Register explicitly** with `createProviderRegistry({ tts: { deepdub: DEEPDUB_TTS_REGISTRATION } })` and pass that registry to routes/workers. Install alone does **not** register the provider.
- **Import kit types/helpers from `@plumbus/voice/provider-kit`**, not deep voice paths.
- **Business logic stays in `brain.run` / capabilities** — this package is a TTS adapter only.
- **Require `DEEPDUB_API_KEY`** at runtime for synthesis and live voice listing.
- **Default model is `dd-etts-3.2`**. Never pass ledger key `deepdub-phantom-x` as `tts.model`. (`dd-etts-3.0` remains available.)
- **Per-turn style voice:** set `DeliveryTone.voiceId` on a tone profile or `resolveTone` result. Do not swap `tts.voiceId` mid-session from app code. Requires `@plumbus/voice` ≥ 0.4.4.
- **REST base** defaults to `https://restapi.deepdub.ai/api/v1` (not `api.deepdub.com`).
- **Voice cloning** — use `createVoiceCloneProvider` / `registerVoiceCloneRoutes` from `@plumbus/voice`; gender is `male`|`female` only; instant `voiceReference` is preview-only. See `docs/voice/voice-cloning.md`.
- Vendor skill: https://raw.githubusercontent.com/deepdub-ai/deepdub-api/main/docs/skills/SKILL.md
