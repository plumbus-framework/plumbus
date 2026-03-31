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

### Step 3: Verify the result

Read the updated versions from each `package.json`:

```bash
grep '"version"' packages/plumbus-core/package.json packages/ui/package.json
```

### Step 4: Report

Tell the user the old and new versions for each package.
