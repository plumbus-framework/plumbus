# Voice cloning (agent recipe)

Use this when an app needs **persisted client voice clones** (upload sample → stable `voiceId` → audiobook/chapter TTS). Full product docs: `docs/voice/voice-cloning.md`.

## Do

1. Install + register the TTS add-on (`DEEPDUB_TTS_REGISTRATION` or `SONIOX_TTS_REGISTRATION`).
2. Use `createVoiceCloneProvider({ providerId, providers, registry })` from app capabilities or jobs.
3. Persist `userId → voice.id` in `afterCloneCreate` (HTTP) or app DB after programmatic `create` / `waitUntilReady`.
4. Synthesize long-form with `createTTSProvider({ voiceSlice: { voiceId: cloneId, … } })` + `synthesizeStream` — not `runVoiceTurn` / LiveKit.
5. Mount `registerVoiceCloneRoutes` with required `access`, `resolveCloneOwner`, `afterCloneCreate`, `listOwnedClones`. Register `@fastify/multipart` first.
6. For Deepdub short preview only: `synthesizeWithVoiceReference` or `referenceAccess` + `POST .../synthesize-reference`.

## Do not

- Dump vendor `list()` into HTTP list — use `listOwnedClones` only.
- Ship synthesize-reference under the same loose policy as “user may clone self.”
- Put vendor API keys or raw samples in the browser.
- Expect Deepdub `voiceReference` for chapter manuscripts (non-streaming HTTP buffer).
- Mutate frozen `defineVoice().tts.voiceId` for per-user realtime clones — select/override at the app layer; audiobook jobs pass `voiceId` dynamically.

## Gender / Soniox UUID

- Deepdub gender: `'male' | 'female'` only.
- Soniox UUID `voice` = clone; non-UUID = built-in name.
