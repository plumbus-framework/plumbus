import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readReleasePlan(root = repositoryRoot) {
  return JSON.parse(readFileSync(join(root, 'release/security-release.json'), 'utf8'));
}

export function readManifests(root = repositoryRoot) {
  return Object.fromEntries(
    readdirSync(join(root, 'packages')).map((directory) => {
      const manifest = JSON.parse(
        readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8'),
      );
      return [manifest.name, manifest];
    }),
  );
}

/** Check both source manifests and the actual metadata emitted by pnpm pack. */
export function releaseIssues(plan, manifests, { tag } = {}) {
  const issues = [];
  for (const name of Object.keys(manifests)) {
    if (!plan.packages[name]) issues.push(`${name}: missing release plan entry`);
  }
  for (const [name, entry] of Object.entries(plan.packages)) {
    const manifest = manifests[name];
    if (!manifest) {
      issues.push(`${name}: missing package manifest`);
      continue;
    }
    if (
      !semver.valid(manifest.version) ||
      !semver.satisfies(manifest.version, entry.peerRange) ||
      semver.lt(manifest.version, entry.version) ||
      semver.satisfies(manifest.version, `^${entry.legacyVersion}`)
    ) {
      issues.push(
        `${name}: version ${manifest.version} does not preserve the explicit upgrade boundary`,
      );
    }
    if (manifest.publishConfig?.tag !== plan.distTag) {
      issues.push(`${name}: publishConfig.tag must stage under ${plan.distTag}`);
    }
    for (const dependency of entry.requiredPeers) {
      if (!manifest.peerDependencies?.[dependency]) {
        issues.push(`${name}: missing required peer ${dependency}`);
      }
    }
    if (name === '@plumbus/ui' && manifest.dependencies?.['@plumbus/core']) {
      issues.push(`${name}: core must be a shared peer, not a nested dependency`);
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        if (!dependency.startsWith('@plumbus/')) continue;
        const target = plan.packages[dependency];
        if (!target) {
          issues.push(`${name}: ${dependency} has no release plan entry`);
          continue;
        }
        if (
          !semver.validRange(range) ||
          !semver.subset(range, target.peerRange) ||
          !semver.satisfies(manifests[dependency]?.version ?? target.version, range) ||
          semver.intersects(range, `^${target.legacyVersion}`)
        ) {
          issues.push(
            `${name}: ${field}.${dependency} (${range}) must accept only the new release family`,
          );
        }
        if (field === 'peerDependencies' && range !== target.peerRange) {
          issues.push(`${name}: copy the canonical ${dependency} peer literal ${target.peerRange}`);
        }
      }
    }
  }
  if (tag && tag !== `v${manifests['@plumbus/core']?.version}`) {
    issues.push(`Release tag ${tag} must match the core version`);
  }
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const packedIndex = process.argv.indexOf('--packed-manifests');
  const packed = packedIndex !== -1;
  const manifests = packed
    ? JSON.parse(readFileSync(process.argv[packedIndex + 1], 'utf8'))
    : readManifests();
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
  const issues = releaseIssues(readReleasePlan(), manifests, { packed, tag });
  if (issues.length) {
    for (const issue of issues) console.error(issue);
    process.exitCode = 1;
  } else {
    console.log(
      `Release boundaries verified for ${Object.keys(manifests).length} packages${packed ? ' (packed)' : ''}.`,
    );
  }
}
