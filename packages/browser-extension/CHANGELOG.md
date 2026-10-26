# Changelog

## 0.4.0-beta.1 — 2026-10-26

- **zod 4.** The scaffold's zero-input sample capability is found through core's `zodTypeName` / `zodObjectShape` (zod 4 has no `_def.typeName`). Core peer `>=0.9.0-beta.6 <0.10.0`.

## 0.4.0-beta.0 — 2026-10-14 — core 0.9 beta family

### Upgrade boundary

- Beta prerelease of the coordinated core 0.9 family (core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, other add-ons 0.4.x), published under the branch-named npm dist-tag `plumbus-next`. npm `latest` stays on the 0.8 stabilization family (core 0.8.1, UI 0.9.0, MCP 0.7.0, voice 0.6.0, auth 0.3.1, other add-ons 0.3.0).
- The 0.8 numbers went to that stable family on `main`, so the beta line moved up one minor: 0.4.0-beta.0 follows 0.3.0-beta.1 and contains everything in the previous betas plus the stable changes merged from `main` (stable 0.3.0). Install the whole beta family together and follow the [0.9 upgrade notes](../../docs/upgrading-core-0.9.md) and the [stabilization upgrade guide](../../docs/upgrading-stabilization.md).
- Plumbus peers are now `@plumbus/core` `>=0.9.0-beta.0 <0.10.0`; they stay prerelease-inclusive until the family goes stable.

### From the earlier betas

- Flow descriptors accept an explicit served `startPath`, and scaffolding filters the background registry and popup inputs to the HTTP surface, so unexposed capabilities and internal flows leave no nonexistent client exports (0.3.0-beta.1).

### From main

- **Vitest 5.0.4** test toolchain and the Node floor `^22.12.0 || ^24.0.0 || >=26.0.0` (was `>=20.6.0`), with package instructions and compatibility guidance refreshed for core 0.8 and agent wiring v21 (stable 0.3.0).
- Runs on `@plumbus/core` 0.9.0-beta.0, which also carries the stable core 0.8.0 fixes (PLB-01..PLB-10: event delivery policy, Redis startup and claim/reclaim recovery, flow claim fencing, durable scheduler ticks and schedule definitions, retry deadlines and flow dead letters, durable job publication, configuration overrides and app config files) and core 0.8.1's background-loop fixes (scheduler poll, delayed-wake promoter).

## 0.3.0 — Stabilization compatibility family

- Upgrade the framework test toolchain to **Vitest 5.0.4** and require Node 22.12+ on the 22.x line, Node 24.x, or Node 26+.

Requires the coordinated core 0.8 family. Follow the [stabilization upgrade guide](../../docs/upgrading-stabilization.md) and the installed `node_modules/@plumbus/core/instructions/stabilization.md`; update installed Plumbus packages together.

- Update Plumbus peers to `@plumbus/core` `0.8.x`. This minor line makes the compatibility change an explicit upgrade.
- Refresh package instructions and compatibility guidance for core 0.8 and agent wiring v21. Runtime APIs in this add-on are unchanged.

## 0.3.0-beta.1 — 2026-09-20

### Fixed

- Flow descriptors accept an explicit served `startPath`, matching UI client generation. Core scaffolding filters background registry and popup inputs to the same HTTP surface; unexposed capabilities and internal flows no longer leave nonexistent client exports.

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

## 0.1.4

### Changed

- Peer dependency `@plumbus/core` corrected to `0.5.x || 0.6.x` so npm accepts `@plumbus/core` **0.6.x** (`^0.5.0 <0.7.0` only matched 0.5.x under npm semver).

## 0.1.3

### Changed

- Peer dependency `@plumbus/core` widened to `^0.5.0 <0.7.0` for `@plumbus/core` **0.6.x** compatibility.

## 0.1.2

### Changed

- Peer dependency `@plumbus/core` updated to `^0.5.0 <0.6.0` for the **0.5.0** release.

## 0.1.1

### Documentation

- README ecosystem table lists `@plumbus/api` (partner external API add-on).

## 0.1.0

- Initial release: `generateBrowserExtensionScaffold` and `plumbus browser-extension scaffold` CLI (in `@plumbus/core`).
