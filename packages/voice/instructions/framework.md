# @plumbus/voice — Framework Instructions for AI Agents

This package is the voice primitive for Plumbus apps. Use it when the user wants realtime speech input/output around an existing app brain, with governed session routes, provider abstraction, and shared cost tracking.

**Do NOT use this package** for: normal text-only LLM calls (`ctx.ai.generate`), a multi-turn text chat UI (`@plumbus/chat` / `@plumbus/chat-ui`), or a clean-room speech agent architecture that bypasses Plumbus routes and `ctx.*`.

## Entry points

| You want to… | Reach for | Lives at |
|---|---|---|
| Declare a new voice surface | `defineVoice({...})` | `@plumbus/voice` barrel |
| Mount session / health / websocket routes | `registerVoiceRoutes(app, routeConfig, voices, opts)` | `@plumbus/voice` |
| Run one turn in-process | `runVoiceTurn(ctx, args)` | `@plumbus/voice` |
| Inspect built-in providers | `listVoiceProviderCatalog()` | `@plumbus/voice` |
| Validate credential coverage | `validateVoiceProviders()` | `@plumbus/voice` |
| Write tests | `mockVoiceRuntime`, `createVoiceTestContext` | `@plumbus/voice/testing` |

## File map (`src/`)

| Concern | File |
|---|---|
| `defineVoice` schema + freeze | `src/define/defineVoice.ts` |
| Route registration | `src/runtime/http.ts` |
| Catalog/admin routes | `src/runtime/http-catalog.ts` |
| Turn runner | `src/runtime/run-turn.ts` |
| Runtime event types | `src/types/event.ts` + `src/runtime/events.ts` |
| Session token helpers | `src/security/session-token.ts` |
| Noise cancellation | `src/runtime/noise-cancellation/` — see [`noise-cancellation.md`](./noise-cancellation.md) |
| WebSocket origin checks | `src/security/ws-origin.ts` |
| Client transcript trust | `src/security/transcript-trust.ts` |
| Built-in provider registrations | `src/providers/` |
| Provider factory + registry | `src/providers/{factory,registry}.ts` |
| Cost helpers | `src/cost/` |
| Test helpers | `src/testing/` |

## How this package composes on core

| Concern | Owned by | Use it via |
|---|---|---|
| Auth / access policy evaluation | `@plumbus/core` | `evaluateAccess`, `authAdapter`, `ExecutionContext` |
| AI ledger | `@plumbus/core` | `ctx.ai.recordProviderCost()` and `onAICostRecorded` |
| Business logic | your app / `@plumbus/core` | the `brain.run(ctx, args)` hook inside `defineVoice` |
| HTTP server / dependency factory | `@plumbus/core` | `routeConfig.createDependencies(auth)` |

## Server STT vs client STT

The STT mode is determined by the provider you pick:

- `web-speech` => **client-side STT**. Browser recognizes speech, sends transcript text.
- `soniox`, `openai-whisper`, `openai-realtime` => **server-side STT**. Audio or provider frames stay on the server side.

If the user asks for `web-speech`, stop and read [`client-stt.md`](./client-stt.md) before editing. That choice changes the trust boundary.

## Critical rules

- **Always include `access` on every voice.** Voice routes are deny-by-default.
- **Never return provider secrets to the browser.** Session/token routes may return only short-lived session tokens and public URLs.
- **Never trust `web-speech` transcript text for billing or audit truth.** Tag it as client-derived and treat it like any other untrusted input.
- **Never mount ad hoc voice routes.** Use `registerVoiceRoutes()` so auth, origin checks, session tokens, and catalog guards stay consistent.
- **Never invent a new local provider adapter just to hit a Whisper-compatible sidecar.** Use `openai-whisper` with `baseUrl`.
- **Never bypass the shared AI ledger.** Voice spend belongs in the same `onAICostRecorded` flow as text AI calls.

## Deeper reference

- `/docs/voice/README.md`
- `/docs/voice/defining-voices.md`
- `/docs/voice/providers.md`
- `/docs/voice/security.md`
- `/docs/voice/testing.md`
