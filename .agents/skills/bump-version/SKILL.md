---
name: bump-version
description: 'Bump package versions for plumbus-core and ui. Use when: bumping the package version, bump version patch, bump version minor, bump version major, releasing a new version, preparing a release, incrementing version numbers, updating package versions, version bump, package version bump.'
argument-hint: 'Specify bump type: patch (default), minor, or major'
---

# Bump Package Versions

Bump the version of all publishable packages (`plumbus-core` and `ui`) using `npm version` without creating git tags.

## When to Use

- Preparing a new release
- User asks to bump, increment, or update package versions
- After merging a feature (patch), adding new functionality (minor), or making breaking changes (major)

## Parameters

| Parameter | Values | Default |
|-----------|--------|---------|
| Bump type | `patch`, `minor`, `major` | `patch` |

## Procedure

### Step 1: Determine bump type

- If the user specified `patch`, `minor`, or `major`, use that.
- If not specified, ask the user or default to `patch`.

### Step 2: Run the bump script

```bash
./scripts/bump-version.sh <patch|minor|major>
```

Example:

```bash
./scripts/bump-version.sh patch
```

### Step 3: Core **minor** bump — update add-on peers (mandatory)

When bumping `@plumbus/core` **minor** (e.g. 0.6.0 → 0.7.0), **before** tagging:

1. Read `packages/plumbus-core/instructions/peer-dependencies.md`.
2. Update the canonical peer literal in that file (e.g. add `0.7.x` to the union).
3. Set `peerDependencies["@plumbus/core"]` in **every** publishable add-on under `packages/` to the new literal — copy from `packages/mcp/package.json`; do not invent ranges.
4. Patch-bump each affected add-on (`chat`, `chat-ui`, `knowledge-base`, `mcp`, `api`, `browser-extension`, `voice` if applicable).
5. Update each add-on's `instructions/framework.md` (or `conventions.md`) peer line to match.

Skip this step for core **patch** bumps that do not add a new supported core line.

### Step 4: Verify the result

Read the updated versions from each `package.json`:

```bash
grep '"version"' packages/plumbus-core/package.json packages/ui/package.json
```

If Step 3 applied, also confirm add-on peers match `packages/plumbus-core/instructions/peer-dependencies.md`:

```bash
grep -r '"@plumbus/core"' packages/*/package.json
```

### Step 5: Report

Tell the user the old and new versions for each package. If Step 3 ran, list which add-ons were peer-bumped.
