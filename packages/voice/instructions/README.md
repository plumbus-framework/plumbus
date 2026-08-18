# @plumbus/voice — Agent Instructions

**After `pnpm add @plumbus/voice`, open this file first:**

`node_modules/@plumbus/voice/instructions/README.md`

This folder ships with the npm tarball and is the entry point for AI coding agents working in apps that depend on `@plumbus/voice`.

**Critical rule:** `web-speech` means **client-side STT**. The browser is producing transcript text and relaying it to the server. Treat that text as untrusted input, not authoritative speech evidence.

**Critical rule:** cloud providers (`openai`, `openai-whisper`, `openai-realtime`, `livekit`, `soniox`, `deepdub`, `elevenlabs`, `minimax`) live in separate `@plumbus/voice-*` packages. Install the add-on **and** pass its `*_REGISTRATION` into `createProviderRegistry()` (then pass that registry to routes/workers; CLI/workers also need `app/voice/registry.ts`). Install alone does not register. Never write a replacement adapter for a missing package. Upgrade playbook: [`docs/upgrading-voice-provider-packages.md`](../../../docs/upgrading-voice-provider-packages.md). See [`providers.md`](./providers.md).

## Provider add-on indexes (exact paths)

| Package | Open after install |
|---|---|
| `@plumbus/voice-openai` | `node_modules/@plumbus/voice-openai/instructions/README.md` |
| `@plumbus/voice-livekit` | `node_modules/@plumbus/voice-livekit/instructions/README.md` |
| `@plumbus/voice-soniox` | `node_modules/@plumbus/voice-soniox/instructions/README.md` |
| `@plumbus/voice-deepdub` | `node_modules/@plumbus/voice-deepdub/instructions/README.md` |
| `@plumbus/voice-elevenlabs` | `node_modules/@plumbus/voice-elevenlabs/instructions/README.md` |
| `@plumbus/voice-minimax` | `node_modules/@plumbus/voice-minimax/instructions/README.md` |

Read these files in order when you need to add, modify, or extend a voice surface:

| File | When to read |
|---|---|
| [`framework.md`](./framework.md) | First. Package boundary (voice vs `@plumbus/voice-*` add-ons), file map, critical rules. |
| [`client-stt.md`](./client-stt.md) | Before wiring `web-speech` or any browser-side transcript relay. |
| [`local-providers.md`](./local-providers.md) | When the user asks for local, offline, self-hosted, or browser-native voice. |
| [`security.md`](./security.md) | Before exposing voice session or catalog routes. Covers short-lived tokens, origin checks, secrets, and transcript trust. |
| [`defining-voices.md`](./defining-voices.md) | When adding a new `defineVoice` config or mounting `registerVoiceRoutes()`. |
| [`continuous-sessions.md`](./continuous-sessions.md) | Continuous / always-listening server-STT: talk-over re-queue, stitched transcripts, sentence chunker, opt-in backchannel. |
| [`providers.md`](./providers.md) | When choosing STT/TTS/transport combinations or adding custom provider registration. |
| [`cost-tracking.md`](./cost-tracking.md) | When tagging STT/TTS/transport spend into the shared AI ledger. |
| [`testing.md`](./testing.md) | When writing smoke, route, websocket, or e2e coverage. |
| [`extending.md`](./extending.md) | When the built-ins are not enough and you need tone hooks, custom providers, or runtime extension points. |
| [`voice-cloning.md`](./voice-cloning.md) | Persisted client voice clones, ownership-aware HTTP routes, Deepdub preview vs long-form TTS. |
| [`noise-cancellation.md`](./noise-cancellation.md) | When configuring Krisp/RNNoise/DTLN on LiveKit transports. |

Provider add-ons ship their own instructions — read `node_modules/@plumbus/voice-<provider>/instructions/framework.md` when wiring that provider.

These files are **prescriptive**. For the deeper conceptual explanation and design rationale, read [`/docs/voice/`](../../../docs/voice/) and [`/docs/upgrading-voice-provider-packages.md`](../../../docs/upgrading-voice-provider-packages.md).
