# @plumbus/voice-deepdub — Framework

**Exact path in a consumer app:** `node_modules/@plumbus/voice-deepdub/instructions/framework.md`

Index: `node_modules/@plumbus/voice-deepdub/instructions/README.md`

`@plumbus/voice-deepdub` is the **Deepdub TTS adapter** for `@plumbus/voice`. Install it when a voice uses `tts.provider: 'deepdub'`.

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
  tts: { provider: 'deepdub', voiceId: process.env.DEEPDUB_VOICE_ID, locale: 'he-IL' },
  brain: { async run(ctx, args) { /* app logic */ return 'ok'; } },
});
```

Pass `registry` into `registerVoiceRoutes()` / worker bootstrap as documented in `@plumbus/voice`.

## Key exports

| Export | Role |
|---|---|
| `DEEPDUB_TTS_REGISTRATION` | Factory + descriptor for the provider registry |
| `DEEPDUB_TTS_DESCRIPTOR` | Catalog entry (`id: 'deepdub'`) |

## Env vars

| Variable | Required | Purpose |
|---|---|---|
| `DEEPDUB_API_KEY` | yes | Deepdub API key |
| `DEEPDUB_BASE_URL` | no | Override API base (default `https://api.deepdub.com`) |

## CLI commands

This package ships no CLI of its own. `plumbus voice worker` and the voice routes from `@plumbus/core` / `@plumbus/voice` require explicit `*_REGISTRATION` in `createProviderRegistry()`.

## Docs

- `docs/voice/providers.md`, `docs/voice/configuration.md`, `docs/voice/cost-tracking.md` (Plumbus monorepo)
- `docs/upgrading-voice-provider-packages.md` — migrating from `@plumbus/voice` 0.3.x
- Package overview: [`../README.md`](../README.md)

## Framework-first

Keep app logic in Plumbus primitives (`defineCapability`, `ctx.*`, voice `brain`). This package only adapts Deepdub's SDK to the voice TTS contract.

## Ecosystem

`@plumbus/voice-deepdub` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
