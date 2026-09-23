# Changelog

## 0.3.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the branch-named npm dist-tag `plumbus-next` (`latest` stays on the 0.7 family). Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.8.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

## 0.2.2 — 2026-09-23

- Forward per-session recognition general/terms/text context, replacing static hints without modifying recognized words.

- Report streaming connection/SDK failures through the STT error callback; allow retry after a rejected connection and ignore obsolete session callbacks.
- Use `@plumbus/voice@0.5.2` for server-resolved recognition context and runtime error recovery. Existing static hints remain supported.

## 0.2.1 — 2026-09-10

### Fixed

- Publish the corrected package README without the added “Release family” banner, using normal `latest` publication. Runtime behavior and peer dependencies are unchanged from 0.2.0.

## 0.2.0 — 2026-09-10

### Upgrade boundary

- Join the coordinated core 0.7.x release family with updated Plumbus peer dependencies. This is a new minor line so legacy caret updates cannot silently select it. Runtime APIs in this package are unchanged.
- Update all installed Plumbus packages together; packages publish to npm’s default `latest` dist-tag. Read the [security release migration checklist](../../docs/upgrading-security-release.md) and run `plumbus init --patch` for agent wiring v16.

## 0.1.4

### Fixed

- **Real-time STT rate corrected to the vendor list price: $0.12/hour** (`0.12/3600` per second, was $0.60/hour). Soniox pricing page (2026): $2.00 per 1M input audio tokens ≈ $0.12/hour for real-time streaming. TTS row unchanged (~$0.70/hour of generated speech, matching the vendor's equivalence).

## 0.1.3

### Added

- **`language_hints_strict`** — sent to Soniox automatically when exactly one language is hinted (the vendor's top documented accuracy recommendation: single-language restriction beats hints alone). Apps can override either way with `stt.options.languageHintsStrict`. Combined with the per-session language narrowing in the LiveKit worker, single-language sessions now run fully restricted.

## 0.1.2

### Added

- Persisted voice cloning on `SONIOX_TTS_REGISTRATION.clone` (`client.tts.voices.*`, `waitUntilReady` / `recompute`).

### Changed

- Dependency `@soniox/node` bumped to `^2.2.0` (required for `tts.voices`).

## 0.1.1

### Added

- `SONIOX_TTS_REGISTRATION` for `tts.provider: 'soniox'` via `@soniox/node` `client.tts.generateStream()` (default `pcm_s16le` @ 16 kHz).
- `SONIOX_TTS_DESCRIPTOR` / `SONIOX_TTS_MODELS` / `SONIOX_TTS_VOICES` catalog surfaces.
- TTS pricing row `soniox-tts` on `SONIOX_VOICE_PRICING` (STT row unchanged under `soniox-stt`). Approximate character estimate of Soniox’s token billing (~$0.70/hr speech), not exact tokens.
- Gated live smoke (`VOICE_LIVE_TEST=1`) for Soniox TTS.

### Fixed

- Attach `SONIOX_VOICE_PRICING` on `SONIOX_STT_REGISTRATION.pricing` and populate `SONIOX_STT_MODELS` with `costModelKey: 'soniox-stt'` so `createProviderRegistry()` seeds ledger USD (no more `$0` rows with real audio seconds).
- Forward `AbortSignal` from `synthesizeStream` into SDK `generateStream({ signal })` for barge-in cancellation.

### Changed

- `SONIOX_VOICE_PRICING` is now a `Record` of STT + TTS rows (was a single STT entry). STT registration reads `SONIOX_VOICE_PRICING['soniox-stt']`.

## 0.1.0

### Added

- Initial extraction of the Soniox STT provider from `@plumbus/voice` 0.3.0.
- Export: `SONIOX_STT_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Required env / credentials: `SONIOX_API_KEY` (`apiKey`).
