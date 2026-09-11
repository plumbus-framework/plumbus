# `@plumbus/core` peer dependency ranges

Read this file before editing `peerDependencies` in any `packages/*/package.json`.

## Core 0.8 family (beta) — explicit upgrade required

Core **0.8.x**, UI **0.9.x**, MCP **0.7.x**, voice **0.6.x**, and the remaining add-ons **0.3.x** form one coordinated release family. It is currently staged as **`-beta.N` prereleases under a branch-named dist-tag (`plumbus-next`)**; see [Upgrading to core 0.8](../../../docs/upgrading-core-0.8.md). This is an intentional migration boundary: legacy caret ranges must not install these packages, and new packages must not accept legacy Plumbus peers. Do not widen these ranges to admit old core/voice lines just to make an installation pass.

The previous family remains on core 0.7.x, UI 0.8.x, MCP 0.6.x, voice 0.5.x, and add-ons 0.2.x (the security release). Historical feature floors are not peer contracts for the new release.

**Prerelease literal.** Semver excludes prereleases from `0.8.x`, so while the family is in beta every peer uses the closed range `>=0.8.0-beta.0 <0.9.0` (same shape for the other lines). It admits `0.8.0-beta.N` and every stable `0.8.N`, and still rejects 0.7.x. When the family goes stable, replace each literal with the plain `0.8.x` form in the same commit that drops the `-beta` suffixes.

## Canonical literals — copy exactly

| Declaring package | Peer target | Literal |
| --- | --- | --- |
| Every add-on that peers on core | `@plumbus/core` | `">=0.8.0-beta.0 <0.9.0"` (stable: `"0.8.x"`) |
| `@plumbus/core` | `@plumbus/mcp` | `">=0.7.0-beta.0 <0.8.0"` (optional; stable: `"0.7.x"`) |
| `@plumbus/core` | `@plumbus/api` | `">=0.3.0-beta.0 <0.4.0"` (optional; stable: `"0.3.x"`) |
| `@plumbus/core` | `@plumbus/ai-bedrock` | `">=0.3.0-beta.0 <0.4.0"` (optional; stable: `"0.3.x"`) |
| `@plumbus/chat` | `@plumbus/knowledge-base` | `">=0.3.0-beta.0 <0.4.0"` (optional; stable: `"0.3.x"`) |
| `@plumbus/chat-ui` | `@plumbus/chat` | `">=0.3.0-beta.0 <0.4.0"` (stable: `"0.3.x"`) |
| `@plumbus/auth-cognito` | `@plumbus/auth` | `">=0.3.0-beta.0 <0.4.0"` (stable: `"0.3.x"`) |
| Every `@plumbus/voice-*` provider | `@plumbus/voice` | `">=0.6.0-beta.0 <0.7.0"` (stable: `"0.6.x"`) |

UI 0.9.x keeps the required core peer (no direct core dependency) and uses `workspace:*` only for development. This prevents npm from accepting old application core plus a hidden new core nested inside UI. Install core and UI together. All Plumbus packages share the application runtime through peers.

Voice does not peer on vendor add-ons. Apps explicitly install only providers they use, register their `*_REGISTRATION` through `createProviderRegistry()`, and pass that registry to routes/workers.

## Rules

- Copy literals from the table and canonical manifests (`packages/mcp/package.json`, `packages/plumbus-core/package.json`, `packages/voice-livekit/package.json`). Never use `^0.x` core peers or derive unions from intuition.
- New-family packages require the new family. Do not publish narrowed peers or migration-requiring behavior as a patch on an old line: an existing caret could select that patch.
- `pnpm install` passing in this workspace does not prove npm consumer compatibility. Validate packed tarballs with npm; production installs use npm.
- Keep all manifests, READMEs, package instructions, changelogs, and AGENTS/CLAUDE in sync.
- The publish workflow picks the npm dist-tag from the branch that contains the tagged commit: `latest` when the commit is on `main`, otherwise the branch name (this beta, tagged from `plumbus-next`, publishes as `plumbus-next`). Promoting to latest is a separate operator decision after the entire family and consumer staging checks pass.

## Future releases

Within this family, patch releases must preserve supported behavior. For another migration-requiring release, first update this policy and the release version table, then move every affected package outside its previous caret range. Re-check direct and transitive dependencies; a core-only bump is insufficient when UI bundles core or peers are auto-installed.

Run lint, format checking, typechecking, tests, and packed npm install checks before publication. Never mutate git, create a release tag, publish, or promote npm dist-tags without the authorization required by repository instructions.

## Consumer upgrade

Read [upgrading-security-release.md](./upgrading-security-release.md) and the 0.8 notes in the root docs, explicitly select the new package versions for every installed Plumbus add-on, and run `plumbus init --patch` for agent wiring **v16**. Keep application business logic in Plumbus primitives and `ctx.*`; do not bypass security checks to make a migration pass.
