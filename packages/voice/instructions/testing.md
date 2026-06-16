# Testing Voice — Agent Recipe

Three layers matter:

1. **Pure smoke tests** for `defineVoice`, catalogs, provider contracts, sentence chunking, and pricing.
2. **In-process runtime tests** with `mockVoiceRuntime` and mock providers.
3. **Route/websocket/e2e tests** for session auth, secret stripping, and handshake flow.

## Default helpers

- `mockVoiceRuntime(...)`
- `createVoiceTestContext(...)`
- `mockSTTProvider`, `mockTTSProvider`, `mockTransportProvider`
- `hebrewTranscriptFixtures`, `pcmSampleFrames`

## Do's

- **Do** keep default CI tests provider-free and deterministic.
- **Do** assert on event shapes (`turn.completed`, `tts.speak`, `session.hello`) instead of large string snapshots.
- **Do** add unauthorized/secret-leak assertions for session and catalog routes.
- **Do** cover websocket handshake behavior with short-lived session tokens.

## Don'ts

- **Don't** require vendor credentials in the default test suite.
- **Don't** snapshot full websocket transcripts.
- **Don't** treat browser STT as billable in tests.

## E2E

Use `createE2EServer()` from `@plumbus/core/testing` when you want a real HTTP server and a websocket round-trip without bringing in a consumer app. Assert cost ledger rows (`transcribe` + `synthesize`) when exercising server STT/TTS mocks.

## Manual smoke

```bash
pnpm --filter @plumbus/voice smoke
```

Runs `scripts/voice-smoke.ts` after build — one mocked `runVoiceTurn` sanity check outside vitest.

## Deeper reference

- `/docs/voice/testing.md`
