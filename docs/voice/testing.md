# Testing Voice

`@plumbus/voice` uses a tiered test strategy so CI can catch wiring regressions quickly without vendor keys.

## Smoke tiers

### Tier 0 — pure

No server and no network. Cover:

- `defineVoice`
- provider catalog boot + credential validation
- provider contract invariants
- sentence chunking
- pricing helpers

### Tier 1 — in-process runtime

Run `runVoiceTurn()` or `mockVoiceRuntime()` with mock providers:

- one complete push-to-talk turn
- client STT relay (`web-speech`)
- client TTS (`browser-tts`)
- cost-record assertions

### Tier 2 — HTTP smoke

Fastify `inject()` tests for:

- session route auth
- access denial
- no-secrets-in-response assertions
- admin-guarded catalog routes
- health route

### Tier 3 — websocket handshake smoke

In-process websocket tests for:

- valid session token => `session.hello`
- invalid/expired token rejected
- one control/audio round-trip with mock/browser TTS bytes
- streaming `stt.partial` events when server STT is active

### Tier 4 — optional live vendor checks

Behind `VOICE_LIVE_TEST=1` (skipped in default CI). OpenAI / Soniox / Deepdub / LiveKit live smokes live in their add-on packages (`@plumbus/voice-openai`, `-soniox`, `-deepdub`, `-livekit`).

## Where provider tests live

`@plumbus/voice` has **no** dependency on the `@plumbus/voice-*` packages (optional peers only), so its tests never import them:

| Test kind | Package |
|---|---|
| Vendor wire/live tests (`openai`, `soniox`, `deepdub`, `elevenlabs`, `minimax`, `livekit`) | the matching `@plumbus/voice-*` package |
| Route/registry tests needing an add-on provider id | `@plumbus/voice`, using local fake registrations (`src/providers/__tests__/fake-registrations.ts`) |
| Browser bundle guard | both `@plumbus/voice` (`client/index.js`) and `@plumbus/voice-livekit` (`client.js`) |

Two guards protect the split and should stay green: `public-api-surface.test.ts` (the `@plumbus/voice` export surface) and `dependency-hygiene.test.ts` (zero vendor SDK deps or imports in `@plumbus/voice`).

## Manual scripts

After `pnpm build`:

```bash
pnpm --filter @plumbus/voice smoke
pnpm --filter @plumbus/voice exec tsx scripts/quality-harness.ts /path/to/input.wav
```

`quality-harness.ts` runs WAV → STT → echo brain → TTS → `.out.wav` using Soniox+Deepdub when those env vars are set, otherwise OpenAI or mock fallbacks. The Soniox/Deepdub profile explicitly imports those packages and registers them.

## `@plumbus/voice/testing`

The testing subpath exports:

- `mockSTTProvider`, `mockTTSProvider`, `mockTransportProvider`
- `createVoiceTestContext`
- `mockVoiceRuntime`
- `hebrewTranscriptFixtures`
- `pcmSampleFrames`

Use these before reaching for custom stubs.

## E2E pattern

For package-level end-to-end tests, use `createE2EServer()` from `@plumbus/core/testing` and register voice routes in the server hook. That gives you:

- a real HTTP server
- standard auth/dependency wiring
- a real websocket round-trip

without requiring a consumer app repo.

## What default CI should avoid

- real vendor credentials
- brittle full-string snapshots of event streams
- assertions that depend on exact prompt wording or provider timing

## Related docs

- [client-stt.md](./client-stt.md)
- [security.md](./security.md)
