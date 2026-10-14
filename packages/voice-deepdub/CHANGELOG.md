# Changelog

## 0.4.0-beta.0 — 2026-10-14 — core 0.9 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.9 family (core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, other add-ons 0.4.x), published under the branch-named npm dist-tag `plumbus-next`. npm `latest` stays on the 0.8 stabilization family (core 0.8.1, UI 0.9.0, MCP 0.7.0, voice 0.6.0, auth 0.3.1, other add-ons 0.3.0).
- The 0.8 numbers went to that stable family on `main`, so the beta line moved up one minor: 0.4.0-beta.0 follows 0.3.0-beta.1 and contains everything in the previous betas plus the stable changes merged from `main` (stable 0.3.0). Install the whole beta family together and follow the [0.9 upgrade notes](../../docs/upgrading-core-0.9.md) and the [stabilization upgrade guide](../../docs/upgrading-stabilization.md).
- Plumbus peers are now `@plumbus/core` `>=0.9.0-beta.0 <0.10.0`, `@plumbus/voice` `>=0.7.0-beta.0 <0.8.0`; they stay prerelease-inclusive until the family goes stable.

### From the earlier betas

- The recommended/default TTS model is `dd-etts-3.3` (0.3.0-beta.1, from stable 0.2.2).

### From main

- **Vitest 5.0.4** test toolchain and the Node floor `^22.12.0 || ^24.0.0 || >=26.0.0` (was `>=20.6.0`), with package instructions and compatibility guidance refreshed for core 0.8 and agent wiring v21 (stable 0.3.0).
- Runs on `@plumbus/core` 0.9.0-beta.0, which also carries the stable core 0.8.0 fixes (PLB-01..PLB-10: event delivery policy, Redis startup and claim/reclaim recovery, flow claim fencing, durable scheduler ticks and schedule definitions, retry deadlines and flow dead letters, durable job publication, configuration overrides and app config files) and core 0.8.1's background-loop fixes (scheduler poll, delayed-wake promoter).

## 0.3.0 — Stabilization compatibility family

- Upgrade the framework test toolchain to **Vitest 5.0.4** and require Node 22.12+ on the 22.x line, Node 24.x, or Node 26+.

Requires the coordinated core 0.8 family. Follow the [stabilization upgrade guide](../../docs/upgrading-stabilization.md) and the installed `node_modules/@plumbus/core/instructions/stabilization.md`; update installed Plumbus packages together.

- Update Plumbus peers to `@plumbus/core` `0.8.x`, `@plumbus/voice` `0.6.x`. This minor line makes the compatibility change an explicit upgrade.
- Refresh package instructions and compatibility guidance for core 0.8 and agent wiring v21. Runtime APIs in this add-on are unchanged.

## 0.3.0-beta.1 — 2026-09-23

Carries 0.2.2 from `main` into the beta family.

- The recommended/default TTS model is now `dd-etts-3.3` (verified with live Hebrew synthesis). `dd-etts-3.2` and `dd-etts-3.0` stay selectable with their contract pricing; pin a model explicitly when its output must not change across upgrades.

## 0.3.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.9.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

## 0.2.2 — 2026-09-23

- Advance the recommended/default TTS model to `dd-etts-3.3` after live Hebrew synthesis verification; retain explicit `dd-etts-3.2` / `dd-etts-3.0` options and existing contract pricing. Pin a model explicitly when its output must remain unchanged across upgrades.

## 0.2.1 — 2026-09-10

### Fixed

- Publish the corrected package README without the added “Release family” banner, using normal `latest` publication. Runtime behavior and peer dependencies are unchanged from 0.2.0.

## 0.2.0 — 2026-09-10

### Upgrade boundary

- Join the coordinated core 0.7.x release family with updated Plumbus peer dependencies. This is a new minor line so legacy caret updates cannot silently select it. Runtime APIs in this package are unchanged.
- Update all installed Plumbus packages together; packages publish to npm’s default `latest` dist-tag. Read the [security release migration checklist](../../docs/upgrading-security-release.md) and run `plumbus init --patch` for agent wiring v16.

## 0.1.4

### Changed

- **Usage is metered in seconds of generated audio, not characters of input text** — Deepdub bills by minutes of generated audio (vendor's conversion: ~1,000 characters ≈ 1 minute), so the provider now accumulates output PCM bytes and reports `seconds` (PCM16 mono at the stream's configured rate, default 48 kHz). The ledger pricing entry's unit is now `audioOutputSeconds`.
- **The rate is env-driven: `DEEPDUB_USD_PER_MINUTE`.** Deepdub pricing is contract-based with no public rate card, so deployments set their real contract rate. Default `0.143` (the effective rate of the smallest published AI-agents tier: $300/mo for 2.1M credits ≈ 2,100 minutes). Resolved per lookup, so the env var applies regardless of import order; invalid values fall back to the default with a warning.

## 0.1.3

### Added

- **The disconnect error is now catchable at all.** `generateToBuffer` → `generateTo` are plain (non-async) functions in `@deepdub/node`, and the socket readyState check throws *synchronously*. `#startGeneration(...).catch(reconnect)` therefore never attached its handler — the throw escaped `synthesizeStream` and no reconnect ever ran, in this version or the previous single-retry one. `#startGeneration` is now `async`, which turns that throw into a rejection the retry path can see. Guarded by a wire test whose fake throws synchronously, as the SDK does; every earlier fake used `async generateToBuffer`, which returns a rejection, so the retry looked healthy while production died.
- **Idle sockets are replaced, not trusted.** `wss://wsapi.deepdub.ai/open` is closed by the far end after an idle gap and the SDK has no keepalive for it (`asyncStreamPing` exists only for the separate `wss://wss.deepdub.ai/ws` streaming endpoint, and API Gateway ignores websocket ping frames regardless). A socket unused for longer than 120 s is now discarded and reopened before synthesis, so a conversational pause costs a handshake instead of a failed turn. Overridable for tests via the credentials option `idleReconnectMs`.
- **Websocket reconnect with backoff** — a dropped or refused Deepdub websocket is now retried up to 3 times, 1 s apart, for both the initial connect and a mid-turn drop (previously: one immediate retry after a drop, none for a refused connect). Deepdub closes an idle socket, so a long conversational pause left the next reply failing with `WebSocket is not connected. Call connect() first.` and the voice session effectively dead. Retries stop early when the turn is aborted, and are skipped once any audio has been published (re-synthesizing would replay the opening of the reply). Spacing is overridable for tests via the provider credentials option `reconnectDelayMs`.

### Fixed

- **`mapDeliveryTone` no longer drops a tone-supplied `voiceId`** — a per-turn `DeliveryTone.voiceId` (e.g. an emotional style variant `voicePromptId` of the same speaker family, chosen by a tone classifier) now overrides the static `tts.voiceId` on every synthesis call, enabling per-register style switching. Requires `@plumbus/voice` ≥ 0.4.4 for the `DeliveryTone.voiceId` field. Falls back to the static voice when absent.

## 0.1.2

### Added

- Persisted voice cloning on `DEEPDUB_TTS_REGISTRATION.clone` (`addVoice` create, REST get/delete, SDK `listVoices`).
- Instant-reference preview via `synthesizeWithVoiceReference` / HTTP `generateToBuffer` + `voiceReference`.
- Session TTS with `tts.options.voiceReference` wraps the HTTP buffer as a single-chunk async iterable (non-streaming preview).

### Changed

- Dependency `@deepdub/node` bumped to `^3.0.2`.

## 0.1.1

### Fixed

- Attach `DEEPDUB_VOICE_PRICING` on `DEEPDUB_TTS_REGISTRATION.pricing` so `createProviderRegistry()` seeds ledger USD for `deepdub-phantom-x`.

## 0.1.0

### Added

- Initial extraction of the Deepdub TTS provider from `@plumbus/voice` 0.3.0.
- Export: `DEEPDUB_TTS_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Required env / credentials: `DEEPDUB_API_KEY` (`apiKey`); optional `DEEPDUB_VOICE_ID` for harnesses and smoke tests.
