# `@plumbus/core` peer dependency ranges

Read this file before editing `peerDependencies` in any `packages/*/package.json`.

## Core 0.9 family (beta) — explicit upgrade required

Core **0.9.x**, UI **0.10.x**, MCP **0.8.x**, voice **0.7.x**, and the remaining add-ons **0.4.x** form one coordinated release family. It is currently staged as **`-beta.N` prereleases under a branch-named dist-tag (`plumbus-next`)**; see [Upgrading to core 0.9](../../../docs/upgrading-core-0.9.md). This is an intentional migration boundary: legacy caret ranges must not install these packages, and new packages must not accept legacy Plumbus peers. Do not widen these ranges to admit old core/voice lines (including the stable 0.8 family) just to make an installation pass.

The 0.9 beta family includes the stabilization changes from the stable 0.8 family. Read [stabilization.md](./stabilization.md) before upgrading. Migrate durable flow, scheduler, and job records; drain old flow-mutating API/worker processes before activation. Do not mix old and new schedulers or workers against the same queues.

The 0.8 numbers belong to the **stabilization family** published from `main` to npm `latest`: core 0.8.x (0.8.1), UI 0.9.x, MCP 0.7.x, voice 0.6.x, and add-ons 0.3.x (auth 0.3.1). Its manifests use the plain literals in the last column of the table below; they are context for this branch, not literals to copy here. The earlier `0.8.0-beta.N` prereleases (peers `>=0.8.0-beta.0 <0.9.0`) are superseded by the 0.9 beta family; do not mix them with it.

The family before that remains core 0.7.x, UI 0.8.x, MCP 0.6.x, voice 0.5.x, and add-ons 0.2.x (the security release). Historical feature floors describe earlier releases, not current peer declarations.

**Prerelease literal.** Semver excludes prereleases from `0.9.x`, so while the family is in beta every peer uses the closed range `>=0.9.0-beta.0 <0.10.0` (same shape for the other lines). It admits `0.9.0-beta.N` and every stable `0.9.N`, and still rejects 0.8.x (stable and beta) and older. When the family goes stable, replace each literal with the plain `0.9.x` form in the same commit that drops the `-beta` suffixes.

## Canonical literals — copy exactly

On this branch copy the **0.9 beta literal**. The next column is the literal that replaces it when the family drops `-beta`. The last column records what the stable 0.8 family on `main` declares.

| Declaring package | Peer target | 0.9 beta literal (this branch) | After dropping `-beta` | Stable 0.8 family (`main`, npm `latest`) |
| --- | --- | --- | --- | --- |
| Every add-on that peers on core | `@plumbus/core` | `">=0.9.0-beta.0 <0.10.0"` | `"0.9.x"` | `"0.8.x"` |
| `@plumbus/core` | `@plumbus/mcp` | `">=0.8.0-beta.0 <0.9.0"` (optional) | `"0.8.x"` | `"0.7.x"` (optional) |
| `@plumbus/core` | `@plumbus/api` | `">=0.4.0-beta.0 <0.5.0"` (optional) | `"0.4.x"` | `"0.3.x"` (optional) |
| `@plumbus/core` | `@plumbus/ai-bedrock` | `">=0.4.0-beta.0 <0.5.0"` (optional) | `"0.4.x"` | `"0.3.x"` (optional) |
| `@plumbus/chat` | `@plumbus/knowledge-base` | `">=0.4.0-beta.0 <0.5.0"` (optional) | `"0.4.x"` | `"0.3.x"` (optional) |
| `@plumbus/chat-ui` | `@plumbus/chat` | `">=0.4.0-beta.0 <0.5.0"` | `"0.4.x"` | `"0.3.x"` |
| `@plumbus/auth-cognito` | `@plumbus/auth` | `">=0.4.0-beta.0 <0.5.0"` | `"0.4.x"` | `"0.3.x"` |
| `@plumbus/payments-stripe` | `@plumbus/payments` | `">=0.4.0-beta.0 <0.5.0"` | `"0.4.x"` | `"0.3.x"` |
| Every `@plumbus/voice-*` provider | `@plumbus/voice` | `">=0.7.0-beta.0 <0.8.0"` | `"0.7.x"` | `"0.6.x"` |

Core's optional `redis` peer stays `"^4.7.0"`. `cron-parser` is a regular core dependency (the framework owns cron parsing), not a peer; apps do not install it.

UI 0.10.x keeps the required core peer `">=0.9.0-beta.0 <0.10.0"` (no direct core dependency; stable UI 0.9.x uses `"0.8.x"`) and uses `workspace:*` only for development. This prevents npm from accepting old application core plus a hidden new core nested inside UI. Install core and UI together. All Plumbus packages share the application runtime through peers.

Voice does not peer on vendor add-ons. Apps explicitly install only providers they use, register their `*_REGISTRATION` through `createProviderRegistry()`, and pass that registry to routes/workers.

## Rules

- Copy literals from the table and canonical manifests (`packages/mcp/package.json`, `packages/plumbus-core/package.json`, `packages/voice-livekit/package.json`). Never use `^0.x` core peers or derive unions from intuition.
- New-family packages require the new family. Do not publish narrowed peers or migration-requiring behavior as a patch on an old line: an existing caret could select that patch.
- `pnpm install` passing in this workspace does not prove npm consumer compatibility. Validate packed tarballs with npm; production installs use npm.
- Keep all manifests, READMEs, package instructions, changelogs, and AGENTS/CLAUDE in sync.
- The publish workflow picks the npm dist-tag from the branch that contains the tagged commit: `latest` when the commit is on `main` (the stable 0.8 family), otherwise the branch name (this beta, tagged from `plumbus-next`, publishes as `plumbus-next`). Promoting to latest is a separate operator decision after the entire family and consumer staging checks pass.

## Future releases

Within this family, patch releases must preserve supported behavior. For another migration-requiring release, first update this policy and the release version table, then move every affected package outside its previous caret range. Re-check direct and transitive dependencies; a core-only bump is insufficient when UI bundles core or peers are auto-installed.

Run lint, format checking, typechecking, tests, and packed npm install checks before publication. Never mutate git, create a release tag, publish, or promote npm dist-tags without the authorization required by repository instructions.

## Consumer upgrade

Read [stabilization.md](./stabilization.md), [upgrading-security-release.md](./upgrading-security-release.md) and the core 0.9 notes in the root docs, explicitly select the new package versions for every installed Plumbus add-on, and run `plumbus init --patch --agent all` for current agent wiring (**v21** in this beta family and stable core 0.8.0+; the 0.8.0-beta.N line shipped v19; v17 added the classification recipe). For classification/provider/model selection, read [ai-classification.md](./ai-classification.md). Keep application business logic in Plumbus primitives and `ctx.*`; do not bypass security checks to make a migration pass.
