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

### Step 3: Coordinated migration releases — mandatory

For the core 0.7 security family, follow the version table in `docs/upgrading-security-release.md` and read `packages/plumbus-core/instructions/peer-dependencies.md` before editing manifests. All 18 packages move outside their previous caret ranges, even add-ons with only peer changes. Copy the new-family-only peer literals; do not widen them to legacy core or voice lines. UI 0.8.x requires core 0.7.x as a shared peer; never restore a direct nested core dependency to bypass the upgrade boundary.

The generic bump script changes only core, UI, and voice. It is not sufficient to prepare a coordinated release: update every package in the plan, its changelog, packaged guidance, lockfile, and root agent instructions. Stage packages under `next`. Run the four repository checks and packed npm consumer checks before publication. Never tag, publish, promote dist-tags, or mutate git without the authorization required by repository instructions.

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
