# Changelog

## 0.3.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.8.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

## 0.2.1 — 2026-09-10

### Fixed

- Publish the corrected package README without the added “Release family” banner, using normal `latest` publication. Runtime behavior and peer dependencies are unchanged from 0.2.0.

## 0.2.0 — 2026-09-10

### Upgrade boundary

- Join the coordinated core 0.7.x release family with updated Plumbus peer dependencies. This is a new minor line so legacy caret updates cannot silently select it. Runtime APIs in this package are unchanged.
- Update all installed Plumbus packages together; packages publish to npm’s default `latest` dist-tag. Read the [security release migration checklist](../../docs/upgrading-security-release.md) and run `plumbus init --patch` for agent wiring v16.

## 0.1.3

### Changed

- Realtime streaming STT now uses the official SDK client (`OpenAIRealtimeWS` from `openai/realtime/ws`) instead of a hand-rolled WebSocket.
- Connection URL model defaults to `gpt-realtime` (override with `stt.options.realtimeConnectionModel`); transcription model remains `stt.model` (default `gpt-realtime-whisper`).
- Custom Realtime bases: credential `baseUrl` / `OPENAI_BASE_URL` (HTTP or `ws`/`wss`) are normalized to HTTP(S) for the SDK, which upgrades to `wss`.
- Depends on `ws` (OpenAI Realtime peer) so the Node Realtime client works at runtime.

## 0.1.2

### Changed

- Whisper STT and OpenAI TTS now call the official [`openai`](https://www.npmjs.com/package/openai) SDK (`audio.transcriptions` / `audio.speech`) instead of hand-rolled `fetch`.
- Custom / third-party OpenAI-compatible endpoints still work via credential `baseUrl` / `OPENAI_BASE_URL` (passed as SDK `baseURL`).
- Apps must **not** import `openai` directly — this package owns the SDK boundary (same pattern as `@deepdub/node` / `@soniox/node`).

## 0.1.1

### Fixed

- Attach `OPENAI_VOICE_PRICING` rows on Whisper / Realtime / TTS registrations so `createProviderRegistry()` seeds ledger USD.

## 0.1.0

### Added

- Initial extraction of OpenAI Whisper STT, OpenAI Realtime STT, and OpenAI TTS providers from `@plumbus/voice` 0.3.0.
- Exports: `OPENAI_WHISPER_STT_REGISTRATION`, `OPENAI_REALTIME_STT_REGISTRATION`, `OPENAI_TTS_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Required env / credentials: `OPENAI_API_KEY` (`apiKey`); optional `OPENAI_BASE_URL`.
