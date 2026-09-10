# Changelog

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
