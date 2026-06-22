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

Behind `VOICE_LIVE_TEST=1` (skipped in default CI):

- Soniox connect/finalize smoke
- Deepdub synthesize smoke
- LiveKit `mintSession` and worker turn loop (`voice-livekit-e2e.live.test.ts`)
- OpenAI Whisper with `src/testing/fixtures/tiny.wav`

## Manual scripts

After `pnpm build`:

```bash
pnpm --filter @plumbus/voice smoke
pnpm --filter @plumbus/voice exec tsx scripts/quality-harness.ts /path/to/input.wav
```

`quality-harness.ts` runs WAV → STT → echo brain → TTS → `.out.wav` using Soniox+Deepdub when those env vars are set, otherwise OpenAI or mock fallbacks.

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
