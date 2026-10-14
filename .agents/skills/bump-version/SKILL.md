---
name: bump-version
description: 'Prepare Plumbus package version changes and coordinated releases, including changelogs, peer ranges, and upgrade instructions. Use when asked to bump versions or prepare a release.'
---

# Bump Package Versions

Prepare the requested package versions without creating git tags. The helper script bumps only core, UI, and voice; coordinated releases also require updates to the other publishable packages.

## When to Use

- Preparing a new release
- User asks to bump, increment, or update package versions
- Preparing a coordinated migration release under the repository's release policy

## Parameters

| Parameter | Values | Default |
|-----------|--------|---------|
| Bump type | `patch`, `minor`, `major` | `patch` |

## Procedure

### Step 1: Determine bump type

- If the user specified `patch`, `minor`, or `major`, use that.
- Otherwise, choose the bump from the requested changes and the repository's release policy. Patch releases preserve supported behavior; migration-requiring releases need a new minor family. Ordinary implementation work does not itself require immediate version changes.
- Read `packages/plumbus-core/instructions/peer-dependencies.md` before changing any Plumbus peer range.

### Step 2: Run the bump script

```bash
./scripts/bump-version.sh <patch|minor|major>
```

Example:

```bash
./scripts/bump-version.sh patch
```

### Step 3: Coordinated migration releases — mandatory

Two release lines exist side by side:

- **Stable family on `main` (npm `latest`).** The current core 0.8 stabilization family follows `docs/upgrading-stabilization.md` and the canonical peer table: core 0.8.x, UI 0.9.x, MCP 0.7.x, voice 0.6.x, and other add-ons 0.3.x, with stable peer literals such as `"0.8.x"`.
- **Beta family on `plumbus-next` (npm dist-tag `plumbus-next`).** The core 0.9 beta family follows the version table in `docs/upgrading-core-0.9.md`: core 0.9.x, UI 0.10.x, MCP 0.8.x, voice 0.7.x, and other add-ons 0.4.x, released as `-beta.N` prereleases. Its peers are prerelease-inclusive literals such as `">=0.9.0-beta.0 <0.10.0"` (core), `">=0.7.0-beta.0 <0.8.0"` (voice) and `">=0.4.0-beta.0 <0.5.0"` (other add-ons); at promotion they become the stable `"0.9.x"`-style literals. If a stable family takes the numbers a beta line was using, the beta line moves up one minor, and a prepared but unpublished beta version is folded into the next entry instead of keeping its own changelog heading.

Read `packages/plumbus-core/instructions/peer-dependencies.md` before editing manifests. Discover all publishable `packages/*/package.json` manifests (currently 24); include add-ons with only peer changes, because every package moves outside its previous caret range. For a future migration release, update the release plan and canonical table before deriving the affected package set. Copy the new-family peer literals; do not widen them to legacy core or voice lines. UI requires core as a shared peer (UI 0.10.x on core 0.9.x; UI 0.9.x on core 0.8.x); never restore a direct nested core dependency to bypass the upgrade boundary. `docs/upgrading-security-release.md` records the 0.7 precedent.

The generic bump script changes only core, UI, and voice. It is not sufficient to prepare a coordinated release: update every package in the plan, its changelog, packaged guidance, lockfile, and root agent instructions. Audit current READMEs, install commands, documentation indexes, dependency badges, and consumer recipes; preserve historical release notes and feature introduction versions. Keep shared framework instructions in AGENTS.md and preserve the @AGENTS.md import in CLAUDE.md. The publish workflow derives the npm dist-tag from the branch that contains the tagged commit: tags on `main` publish to `latest`, tags on `plumbus-next` publish to the `plumbus-next` dist-tag; never pass `latest` for a prerelease. Run the four repository checks and packed npm consumer checks before publication. Never tag, publish, promote dist-tags, or mutate git without the authorization required by repository instructions.

### Step 4: Verify the result

Read the updated versions from each `package.json`:

```bash
rg '"version"' packages/*/package.json
```

If Step 3 applied, also confirm add-on peers match `packages/plumbus-core/instructions/peer-dependencies.md`:

```bash
rg '"@plumbus/core"' packages/*/package.json
```

### Step 5: Report

Tell the user the old and new versions for each package. If Step 3 ran, list which add-ons were peer-bumped.
