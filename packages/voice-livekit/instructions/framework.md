# @plumbus/voice-livekit — Framework

**Exact path in a consumer app:** `node_modules/@plumbus/voice-livekit/instructions/framework.md`

Index: `node_modules/@plumbus/voice-livekit/instructions/README.md`

`@plumbus/voice-livekit` is the **LiveKit transport + agent worker + browser session** adapter for `@plumbus/voice`. Install it when a voice uses `transport.provider: 'livekit'`.

## When not to use

- Do **not** install this package for `transport.provider: 'websocket'` — WebSocket transport stays built into `@plumbus/voice`.
- Do **not** import `@livekit/*` / `livekit-client` / `livekit-server-sdk` directly for Plumbus voice sessions; use this package's exports (`./client`, agent worker, registration).
- Skip it for browser-only PTT prototypes that should stay on `websocket` + `web-speech` + `browser-tts`.

**Peers (copy literals):**

```json
"@plumbus/core": "0.6.x",
"@plumbus/voice": "0.4.x"
```

Optional peers: `livekit-client` `^2.0.0` (browser), `@livekit/krisp-noise-filter` `^0.4.0` (client Krisp), `fastify` `^5.0.0`.

## Install

```bash
pnpm add @plumbus/voice @plumbus/voice-livekit
```

For browser PTT/continuous clients also install `livekit-client`.

## Quick start

```ts
import { createProviderRegistry, defineVoice, registerVoiceRoutes } from '@plumbus/voice';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '@plumbus/voice-livekit';

const registry = createProviderRegistry({
  transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
});

export const supportVoice = defineVoice({
  name: 'support',
  // …
  transport: { provider: 'livekit', mode: 'continuous' },
  brain: { async run(ctx, args) { /* app logic */ return 'ok'; } },
});
```

Register `LIVEKIT_TRANSPORT_REGISTRATION` with `createProviderRegistry({ transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION } })`.

## Subpaths

| Import | Exports |
|---|---|
| `@plumbus/voice-livekit` | `LIVEKIT_TRANSPORT_REGISTRATION`, `mintLiveKitParticipantToken`, agent worker APIs, NC helpers |
| `@plumbus/voice-livekit/client` | `createLiveKitVoiceSession`, `applyClientNoiseCancellation` |
| `@plumbus/voice-livekit/worker` | `startVoiceAgentWorker`, `createVoiceAgentEntry`, bootstrap helpers |

**Browser critical:** `@plumbus/voice-livekit/client` must not import `@plumbus/core` or `@plumbus/voice` package roots. It uses `@plumbus/core/errors` and `@plumbus/voice/noise-cancellation`. Importing the roots pulls the CLI / server runtime into the Next client graph and breaks Turbopack.

## Key exports

| Export | Role |
|---|---|
| `LIVEKIT_TRANSPORT_REGISTRATION` | Factory + descriptor for the provider registry |
| `LIVEKIT_TRANSPORT_DESCRIPTOR` | Catalog entry (`id: 'livekit'`) |
| `recordLiveKitTransportCost` / `LIVEKIT_VOICE_PRICING` | Transport cost helper + pricing |
| `parseLiveKitParticipantContext` | Participant metadata → brain input |
| `startVoiceAgentWorker` / `createVoiceAgentEntry` | LiveKit Agents worker entry |
| `createLiveKitVoiceSession` | Browser room session (`./client`) |

## Env vars

| Variable | Required | Purpose |
|---|---|---|
| `LIVEKIT_URL` | yes | LiveKit WebSocket URL (`wss://…`) |
| `LIVEKIT_API_KEY` | yes | API key for token minting / worker |
| `LIVEKIT_API_SECRET` | yes | API secret for token minting / worker |
| `LIVEKIT_LOG_LEVEL` | no | Agent logger level |
| `PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE` | child workers | Absolute path to bootstrap module |

## CLI commands

| Command | Requires this package |
|---|---|
| `plumbus voice worker` | yes — agent dispatch and room-join both need the LiveKit transport |

The command lives in `@plumbus/core` and dynamically imports this package for `startVoiceAgentWorker` / `joinVoiceRoomSession`. Without it installed, the CLI fails with `voice.provider_package_missing` and an install hint.

## Read next (by task)

| Task | File |
|---|---|
| Browser session | [`client-session.md`](./client-session.md) |
| Agent worker / CLI | [`agent-worker.md`](./agent-worker.md) |
| Noise cancellation | [`noise-cancellation.md`](./noise-cancellation.md) |

## Docs

- `docs/voice/livekit-continuous-voice.md`, `docs/voice/transports.md`, `docs/voice/noise-cancellation.md`
- `docs/upgrading-voice-provider-packages.md` — the three moved import paths (`./client` session + sync agent helpers)
- Package overview: [`../README.md`](../README.md)

## Framework-first

Keep app logic in Plumbus primitives (`defineCapability`, `ctx.*`, voice `brain`). This package only adapts LiveKit rooms, tokens, and audio pipelines to the voice transport contract.

## Ecosystem

`@plumbus/voice-livekit` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
