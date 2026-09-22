# LiveKit agent worker — Agent Recipe

Use this when starting a LiveKit Agents worker for continuous/room voice (`plumbus voice worker` or programmatic start).

**Exact path in a consumer app:**

`node_modules/@plumbus/voice-livekit/instructions/agent-worker.md`

## Rules

1. Import worker APIs from `@plumbus/voice-livekit` or `@plumbus/voice-livekit/worker`.
2. Pass an explicit `registry` that includes `LIVEKIT_TRANSPORT_REGISTRATION` (and any STT/TTS registrations the voice uses).
3. CLI/workers load `app/voice/registry.ts` via `loadAppVoiceRegistry()` — export `voiceProviderRegistry` there. There is no soft auto-register.
4. Require `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

## CLI

```bash
plumbus voice worker
```

The command lives in `@plumbus/core` and dynamically imports this package. Missing package → `voice.provider_package_missing`. Missing `app/voice/registry.ts` → hard failure (no fallback registry).

## Programmatic entry

```ts
import { startVoiceAgentWorker, createVoiceAgentEntry } from '@plumbus/voice-livekit';
// or: from '@plumbus/voice-livekit/worker'
```

Use `createVoiceAgentEntry` for the LiveKit Agents entrypoint; `startVoiceAgentWorker` for the process bootstrap used by the CLI.

The worker narrows STT `language_hints` from participant metadata (`language: '<code>'`). Pair that with Soniox’s single-language `language_hints_strict` default (`stt.options.languageHintsStrict` to override).

Agent-worker `parsePcmFormat` understands short-form `pcm16-16k` / `pcm16-24k` / `pcm16-48k`. Use the form that matches the STT sample rate — a mismatch falls through the JS linear resampler (quality loss; the runtime logs once per rate pair).

Continuous session behavior (talk-over re-queue, stitched transcripts, sentence chunker): `node_modules/@plumbus/voice/instructions/continuous-sessions.md`.

## App registry (required)

```ts
// app/voice/registry.ts
import { createProviderRegistry } from '@plumbus/voice';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '@plumbus/voice-livekit';
// + STT/TTS *_REGISTRATION imports for providers the voice uses

export const voiceProviderRegistry = createProviderRegistry({
  transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
  // stt: { … }, tts: { … },
});
```

## Related recipes

| Task | Read |
|---|---|
| Install / register transport | [`framework.md`](./framework.md) |
| Browser session | [`client-session.md`](./client-session.md) |
| Agent NC | [`noise-cancellation.md`](./noise-cancellation.md) |
| Parent voice defining/routes | `node_modules/@plumbus/voice/instructions/defining-voices.md` |
| Continuous session behavior | `node_modules/@plumbus/voice/instructions/continuous-sessions.md` |

Concept docs (monorepo): `docs/voice/livekit-continuous-voice.md`.
