# @plumbus/voice — Agent Instructions

This folder ships with the npm tarball and is the entry point for AI coding agents working in apps that depend on `@plumbus/voice`.

**Critical rule:** `web-speech` means **client-side STT**. The browser is producing transcript text and relaying it to the server. Treat that text as untrusted input, not authoritative speech evidence.

Read these files in order when you need to add, modify, or extend a voice surface:

| File | When to read |
|---|---|
| [`framework.md`](./framework.md) | First. Package boundary, file map, critical rules, and how voice composes on core/chat. |
| [`client-stt.md`](./client-stt.md) | Before wiring `web-speech` or any browser-side transcript relay. |
| [`local-providers.md`](./local-providers.md) | When the user asks for local, offline, self-hosted, or browser-native voice. |
| [`security.md`](./security.md) | Before exposing voice session or catalog routes. Covers short-lived tokens, origin checks, secrets, and transcript trust. |
| [`defining-voices.md`](./defining-voices.md) | When adding a new `defineVoice` config or mounting `registerVoiceRoutes()`. |
| [`providers.md`](./providers.md) | When choosing STT/TTS/transport combinations or adding custom provider registration. |
| [`cost-tracking.md`](./cost-tracking.md) | When tagging STT/TTS/transport spend into the shared AI ledger. |
| [`testing.md`](./testing.md) | When writing smoke, route, websocket, or e2e coverage. |
| [`extending.md`](./extending.md) | When the built-ins are not enough and you need tone hooks, custom providers, or runtime extension points. |
| [`noise-cancellation.md`](./noise-cancellation.md) | When configuring Krisp/RNNoise/DTLN on LiveKit transports. |

These files are **prescriptive**. For the deeper conceptual explanation and design rationale, read [`/docs/voice/`](../../../docs/voice/).
