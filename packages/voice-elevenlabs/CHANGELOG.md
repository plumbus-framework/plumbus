# Changelog

## 0.3.0-beta.0 — 2026-09-11 — core 0.8 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.8 family (core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, other add-ons 0.3.x), published under the npm `beta` dist-tag. Previous caret ranges exclude it; install the whole family together and follow the [0.8 upgrade notes](../../docs/upgrading-core-0.8.md). Internal peers use prerelease-inclusive ranges (for example `>=0.8.0-beta.0 <0.9.0`) until the family goes stable.

## 0.2.1 — 2026-09-10

### Fixed

- Publish the corrected package README without the added “Release family” banner, using normal `latest` publication. Runtime behavior and peer dependencies are unchanged from 0.2.0.

## 0.2.0 — 2026-09-10

### Upgrade boundary

- Join the coordinated core 0.7.x release family with updated Plumbus peer dependencies. This is a new minor line so legacy caret updates cannot silently select it. Runtime APIs in this package are unchanged.
- Update all installed Plumbus packages together; packages publish to npm’s default `latest` dist-tag. Read the [security release migration checklist](../../docs/upgrading-security-release.md) and run `plumbus init --patch` for agent wiring v16.

## 0.1.1

### Fixed

- Attach `ELEVENLABS_VOICE_PRICING` on `ELEVENLABS_TTS_REGISTRATION.pricing` for ledger USD via `createProviderRegistry()`.

## 0.1.0

### Added

- Initial extraction of the ElevenLabs TTS provider from `@plumbus/voice` 0.3.0.
- Export: `ELEVENLABS_TTS_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Official SDK integration via `@elevenlabs/elevenlabs-js` (`client.textToSpeech.stream()` for both flash and v3).
- Injectable `credentials.options.elevenLabsClientFactory` for tests and custom clients (lazy SDK import when unset).
- Required env / credentials: `ELEVENLABS_API_KEY` (`apiKey`).

### Changed

- Flash and v3 synthesis both use the SDK streaming API; the hand-rolled WebSocket flash path is removed.
- Catalog descriptor reports `streaming: true` for all ElevenLabs models (including `eleven_v3`).

### Removed

- `chunkLengthSchedule` voice option support (no SDK equivalent on `textToSpeech.stream()`).
- Direct `fetch` / WebSocket wire helpers for ElevenLabs TTS.
