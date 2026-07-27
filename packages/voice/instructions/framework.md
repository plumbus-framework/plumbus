# @plumbus/voice — Framework Instructions for AI Agents

**Exact path in a consumer app:** `node_modules/@plumbus/voice/instructions/framework.md`

Index (open first): `node_modules/@plumbus/voice/instructions/README.md`

This package is the voice primitive for Plumbus apps. Use it when the user wants realtime speech input/output around an existing app brain, with governed session routes, provider abstraction, and shared cost tracking.

**`package.json` peer (framework releases):** `"@plumbus/core": "0.6.x"` — voice requires core 0.6+; copy from `packages/voice/package.json`; see `packages/plumbus-core/instructions/peer-dependencies.md`.

**Provider add-ons (copy literals):** `@plumbus/voice-openai` / `-deepdub` / `-soniox` / `-elevenlabs` / `-minimax` / `-livekit` at `"0.1.x"`, peer `@plumbus/voice` `"0.4.x"`. Install only what the app uses, then pass each `*_REGISTRATION` into `createProviderRegistry()`. See [`docs/upgrading-voice-provider-packages.md`](../../../docs/upgrading-voice-provider-packages.md).

**Do NOT use this package** for: normal text-only LLM calls (`ctx.ai.generate`), a multi-turn text chat UI (`@plumbus/chat` / `@plumbus/chat-ui`), or a clean-room speech agent architecture that bypasses Plumbus routes and `ctx.*`.

## Package boundary

| Lives in `@plumbus/voice` | Lives in `@plumbus/voice-*` add-ons |
|---|---|
| Runtime, HTTP routes, WebSocket transport, browser STT/TTS | Vendor adapters + their descriptors, models, pricing, env credentials (including OpenAI) |
| Room-transport **contract types** + transport-agnostic `/token` + `beforeSession.room` | LiveKit transport, agent worker, browser session, NC engines, LiveKit cost/context helpers |
| Built-in pricing (websocket only) + `loadAppVoiceRegistry` | Registration exports (`*_REGISTRATION`) + `resolveCredentialsFromEnv` |
| `@plumbus/voice/provider-kit` for add-on authors | `startVoiceAgentWorker`, `joinVoiceRoomSession`, `createLiveKitVoiceSession`, etc. |

## Entry points

| You want to… | Reach for | Lives at |
|---|---|---|
| Declare a new voice surface | `defineVoice({...})` | `@plumbus/voice` barrel |
| Mount session / health / websocket / token routes | `registerVoiceRoutes(app, routeConfig, voices, { providers, registry })` | `@plumbus/voice` |
| Register cloud/LiveKit/OpenAI providers | `createProviderRegistry({ stt/tts/transport: { …REGISTRATION } })` | `@plumbus/voice` + add-on packages |
| CLI/worker registry | `app/voice/registry.ts` exporting `voiceProviderRegistry` | App code; loaded by `loadAppVoiceRegistry()` |
| Run one turn in-process | `runVoiceTurn(ctx, args)` | `@plumbus/voice` |
| Inspect provider catalog | `listVoiceProviderCatalog(registry?)` | `@plumbus/voice` |
| Write tests | `mockVoiceRuntime`, `createVoiceTestContext` | `@plumbus/voice/testing` |
| LiveKit browser session | `createLiveKitVoiceSession` | `@plumbus/voice-livekit/client` |
| LiveKit agent entry / worker | `createVoiceAgentEntry`, `startVoiceAgentWorker`, `joinVoiceRoomSession` | `@plumbus/voice-livekit` |

## File map (`src/`)

| Concern | File |
|---|---|
| `defineVoice` schema + freeze | `src/define/defineVoice.ts` |
| Route registration | `src/runtime/http.ts` |
| Catalog/admin routes | `src/runtime/http-catalog.ts` |
| Turn runner | `src/runtime/run-turn.ts` |
| Session token helpers | `src/security/session-token.ts` |
| Built-in provider registrations | `src/providers/` (websocket, web-speech, browser-tts only) |
| Built-in pricing | `src/cost/voice-pricing.ts` (websocket only) |
| App registry loader | `src/discover/load-app-voice-registry.ts` |
| Add-on author surface | `src/provider-kit/index.ts` (`@plumbus/voice/provider-kit`) |

## Non-negotiables

1. **Framework-first** — session minting, access checks, and cost recording go through Plumbus routes/`ctx.*`.
2. **Explicit registration** — never invent a local adapter for cloud vendors; install the package and register `*_REGISTRATION`. There is no auto-load and no install-hint package map.
3. **Transport-agnostic token** — use `beforeSession.room` (not `.livekit`) for `/token` mint options.
4. **CLI/workers** — export `voiceProviderRegistry` from `app/voice/registry.ts`.
