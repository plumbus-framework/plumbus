# @plumbus/voice-deepdub — Framework

**Exact path in a consumer app:** `node_modules/@plumbus/voice-deepdub/instructions/framework.md`

Index: `node_modules/@plumbus/voice-deepdub/instructions/README.md`

`@plumbus/voice-deepdub` is the **Deepdub TTS adapter** for `@plumbus/voice`. Install it when a voice uses `tts.provider: 'deepdub'`.

Vendor API reference (source of truth for endpoints/models): [Deepdub API skill](https://raw.githubusercontent.com/deepdub-ai/deepdub-api/main/docs/skills/SKILL.md) / [AGENTS.md](https://raw.githubusercontent.com/deepdub-ai/deepdub-api/main/docs/skills/AGENTS.md). Live docs: https://docs.deepdub.app

## When not to use

- Do **not** install this package for OpenAI, browser, ElevenLabs, or MiniMax TTS — those are separate providers (built-in or other `@plumbus/voice-*` add-ons).
- Do **not** import `@deepdub/node` directly in app code; this package owns the SDK boundary.
- Skip it for local/offline stacks that should stay on `browser-tts` / `openai`.

**Peers (copy literals):**

```json
"@plumbus/core": "0.6.x",
"@plumbus/voice": "0.4.x"
```

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-deepdub
```

## Quick start

```ts
import { createProviderRegistry, defineVoice } from '@plumbus/voice';
import { DEEPDUB_TTS_REGISTRATION } from '@plumbus/voice-deepdub';

const registry = createProviderRegistry({
  tts: { deepdub: DEEPDUB_TTS_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  // …
  tts: {
    provider: 'deepdub',
    // Plumbus default is dd-etts-3.2 — never pass ledger key deepdub-phantom-x as model.
    model: 'dd-etts-3.2',
    voiceId: process.env.DEEPDUB_VOICE_ID,
    locale: 'he-IL',
  },
  brain: { async run(ctx, args) { /* app logic */ return 'ok'; } },
});
```

Pass `registry` into `registerVoiceRoutes()` / worker bootstrap as documented in `@plumbus/voice`.

## Key exports

| Export | Role |
|---|---|
| `DEEPDUB_TTS_REGISTRATION` | Factory + descriptor for the provider registry (includes `.clone`) |
| `DEEPDUB_TTS_DESCRIPTOR` | Catalog entry (`id: 'deepdub'`) |

## Env vars

| Variable | Required | Purpose |
|---|---|---|
| `DEEPDUB_API_KEY` | yes | Deepdub API key (`x-api-key`; format `dd-…`) |
| `DEEPDUB_BASE_URL` | no | Override REST base (default `https://restapi.deepdub.ai/api/v1`; EU: `https://eu-restapi.deepdub.ai/api/v1`) |
| `DEEPDUB_VOICE_ID` | for live/smoke | Persisted `voicePromptId` |
| `DEEPDUB_MODEL` | for live/smoke | Optional; defaults to `dd-etts-3.2` in the live test |

## Deepdub wire notes (from vendor skill)

| Surface | Plumbus path |
|---|---|
| Streaming TTS | WS `DeepdubClient` + `generateToBuffer` / `onChunk` / `headerless` (default protocol) |
| Instant clone preview | HTTP `generateToBuffer` + `voiceReference` (Buffer) — short text only |
| List / create voices | SDK `listVoices` / `addVoice` with `{ protocol: 'http' }` |
| Get / delete voice | REST `GET|DELETE /voice/{prompt_id}` + `x-api-key` (JS SDK still has no first-class delete in 3.0.2) |
| Auth | Header `x-api-key` on REST; WS connects with the same key |
| Default model | `dd-etts-3.2` (catalog also lists `dd-etts-3.0`) |
| Cost ledger key | `deepdub-phantom-x` — **not** a `tts.model` value |

Sample preset for smoke (Storyteller M, en-US): `bd1b00bb-be1c-4679-8eaa-0fcbfd4ff773`. More presets: https://docs.deepdub.app/voice-presets

Deepdub publishes a **rate-limited free trial key** in their skill docs (IP-limited). Prefer a real project key for production. Live smoke:

```bash
VOICE_LIVE_TEST=1 \
  DEEPDUB_API_KEY=… \
  DEEPDUB_VOICE_ID=bd1b00bb-be1c-4679-8eaa-0fcbfd4ff773 \
  pnpm --filter @plumbus/voice-deepdub exec vitest run src/__tests__/deepdub-tts.live.test.ts
```

## CLI commands

This package ships no CLI of its own. `plumbus voice worker` and the voice routes from `@plumbus/core` / `@plumbus/voice` require explicit `*_REGISTRATION` in `createProviderRegistry()`.

## Docs

- `docs/voice/providers.md`, `docs/voice/configuration.md`, `docs/voice/cost-tracking.md`, `docs/voice/voice-cloning.md` (Plumbus monorepo)
- `docs/upgrading-voice-provider-packages.md` — migrating from `@plumbus/voice` 0.3.x
- Package overview: [`../README.md`](../README.md)

## Voice cloning

`DEEPDUB_TTS_REGISTRATION.clone` supports persisted create (`addVoice`), REST get/delete, and instant-reference preview. Gender `'male' | 'female'` only (mapped to vendor `MALE`/`FEMALE`). Long-form audiobook synthesis uses persisted `voiceId` (`voicePromptId`) + streaming WS — not `voiceReference`. Upload cap 20 MB (vendor).

## Framework-first

Keep app logic in Plumbus primitives (`defineCapability`, `ctx.*`, voice `brain`). This package only adapts Deepdub's SDK to the voice TTS contract.

## Ecosystem

`@plumbus/voice-deepdub` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
