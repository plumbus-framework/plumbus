# @plumbus/voice-soniox — Framework

**Exact path in a consumer app:** `node_modules/@plumbus/voice-soniox/instructions/framework.md`

Index: `node_modules/@plumbus/voice-soniox/instructions/README.md`

`@plumbus/voice-soniox` is the **Soniox STT adapter** for `@plumbus/voice`. Install it when a voice uses `stt.provider: 'soniox'`.

## When not to use

- Do **not** install this package for `web-speech` (builtin) or OpenAI STT (`@plumbus/voice-openai`).
- Do **not** import `@soniox/node` directly in app code; this package owns the SDK boundary.
- Skip it for browser-only / zero-cloud prototypes that should stay on `web-speech`.

**Peers (copy literals):**

```json
"@plumbus/core": "0.6.x",
"@plumbus/voice": "0.4.x"
```

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-soniox
```

## Quick start

```ts
import { createProviderRegistry, defineVoice } from '@plumbus/voice';
import { SONIOX_STT_REGISTRATION } from '@plumbus/voice-soniox';

const registry = createProviderRegistry({
  stt: { soniox: SONIOX_STT_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  // …
  stt: { provider: 'soniox', model: 'stt-rt-v5', languages: ['he', 'en'] },
  brain: { async run(ctx, args) { /* app logic */ return 'ok'; } },
});
```

Pass `registry` into `registerVoiceRoutes()` / worker bootstrap as documented in `@plumbus/voice`.

## Key exports

| Export | Role |
|---|---|
| `SONIOX_STT_REGISTRATION` | Factory + descriptor for the provider registry |
| `SONIOX_STT_DESCRIPTOR` | Catalog entry (`id: 'soniox'`) |

## Env vars

| Variable | Required | Purpose |
|---|---|---|
| `SONIOX_API_KEY` | yes | Soniox API key |
| `SONIOX_BASE_URL` | no | Override API base when supported by credentials |

## CLI commands

This package ships no CLI of its own. `plumbus voice worker` and the voice routes from `@plumbus/core` / `@plumbus/voice` require explicit `*_REGISTRATION` in `createProviderRegistry()`.

## Docs

- `docs/voice/providers.md`, `docs/voice/configuration.md`, `docs/voice/cost-tracking.md` (Plumbus monorepo)
- `docs/upgrading-voice-provider-packages.md` — migrating from `@plumbus/voice` 0.3.x
- Package overview: [`../README.md`](../README.md)

## Framework-first

Keep app logic in Plumbus primitives (`defineCapability`, `ctx.*`, voice `brain`). This package only adapts Soniox's SDK to the voice STT contract.

## Ecosystem

`@plumbus/voice-soniox` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
