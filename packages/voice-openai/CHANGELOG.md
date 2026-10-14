# Changelog

## 0.4.0-beta.0 — 2026-10-14 — core 0.9 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.9 family (core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, other add-ons 0.4.x), published under the branch-named npm dist-tag `plumbus-next`. npm `latest` stays on the 0.8 stabilization family (core 0.8.1, UI 0.9.0, MCP 0.7.0, voice 0.6.0, auth 0.3.1, other add-ons 0.3.0).
- The 0.8 numbers went to that stable family on `main`, so the beta line moved up one minor: 0.4.0-beta.0 follows 0.3.0-beta.1 and contains everything in the previous betas plus the stable changes merged from `main` (stable 0.3.0). Install the whole beta family together and follow the [0.9 upgrade notes](../../docs/upgrading-core-0.9.md) and the [stabilization upgrade guide](../../docs/upgrading-stabilization.md).
- Plumbus peers are now `@plumbus/core` `>=0.9.0-beta.0 <0.10.0`, `@plumbus/voice` `>=0.7.0-beta.0 <0.8.0`; they stay prerelease-inclusive until the family goes stable.

### From the earlier betas

- `gpt-realtime-whisper` is priced at $0.017 per minute instead of Whisper's $0.006 (0.3.0-beta.1). Stable 0.3.0 does not have this fix.

### From main

- **Vitest 5.0.4** test toolchain and the Node floor `^22.12.0 || ^24.0.0 || >=26.0.0` (was `>=20.6.0`), with package instructions and compatibility guidance refreshed for core 0.8 and agent wiring v21 (stable 0.3.0).
- Runs on `@plumbus/core` 0.9.0-beta.0, which also carries the stable core 0.8.0 fixes (PLB-01..PLB-10: event delivery policy, Redis startup and claim/reclaim recovery, flow claim fencing, durable scheduler ticks and schedule definitions, retry deadlines and flow dead letters, durable job publication, configuration overrides and app config files) and core 0.8.1's background-loop fixes (scheduler poll, delayed-wake promoter).

## 0.3.0 — Stabilization compatibility family

- Upgrade the framework test toolchain to **Vitest 5.0.4** and require Node 22.12+ on the 22.x line, Node 24.x, or Node 26+.

Requires the coordinated core 0.8 family. Follow the [stabilization upgrade guide](../../docs/upgrading-stabilization.md) and the installed `node_modules/@plumbus/core/instructions/stabilization.md`; update installed Plumbus packages together.

- Update Plumbus peers to `@plumbus/core` `0.8.x`, `@plumbus/voice` `0.6.x`. This minor line makes the compatibility change an explicit upgrade.
- Refresh package instructions and compatibility guidance for core 0.8 and agent wiring v21. Runtime APIs in this add-on are unchanged.

## 0.3.0-beta.1 — 2026-10-01

### Fixed

- **`gpt-realtime-whisper` costs $0.017 per minute.** The bundled rate was $0.006, Whisper's price, so voice cost records for the default realtime transcription model came to about a third of OpenAI's bill.

## 0.3.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.9.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

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
