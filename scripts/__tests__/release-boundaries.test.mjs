import assert from 'node:assert/strict';
import { test } from 'node:test';
import semver from 'semver';
import { readManifests, readReleasePlan, releaseIssues } from '../check-release-boundaries.mjs';

const plan = readReleasePlan();
const manifests = readManifests();

for (const [name, entry] of Object.entries(plan.packages)) {
  test(`${name}: a legacy caret update cannot select the new version`, () => {
    assert.equal(semver.satisfies(entry.legacyVersion, `^${entry.legacyVersion}`), true);
    assert.equal(semver.satisfies(manifests[name].version, `^${entry.legacyVersion}`), false);
  });
}

test('the complete new source family is mutually compatible', () => {
  assert.deepEqual(releaseIssues(plan, manifests), []);
});

test('rejects accidentally reverting core to a patch release', () => {
  const changed = structuredClone(manifests);
  changed['@plumbus/core'].version = '0.6.20';
  assert.ok(
    releaseIssues(plan, changed).some((issue) => issue.includes('explicit upgrade boundary')),
  );
});

test('rejects an add-on whose peer union admits the legacy core', () => {
  const changed = structuredClone(manifests);
  changed['@plumbus/mcp'].peerDependencies['@plumbus/core'] = '0.6.x || 0.7.x';
  assert.ok(
    releaseIssues(plan, changed).some((issue) => issue.includes('only the new release family')),
  );
});

test('rejects restoring an add-on to its legacy version', () => {
  const changed = structuredClone(manifests);
  changed['@plumbus/voice-livekit'].version = '0.1.5';
  assert.ok(
    releaseIssues(plan, changed).some((issue) => issue.includes('explicit upgrade boundary')),
  );
});

test('rejects publication straight to latest', () => {
  const changed = structuredClone(manifests);
  changed['@plumbus/ui'].publishConfig.tag = 'latest';
  assert.ok(releaseIssues(plan, changed).some((issue) => issue.includes('stage under next')));
});

test('packed UI requires the shared core peer and cannot hide a second runtime', () => {
  const changed = structuredClone(manifests);
  assert.deepEqual(releaseIssues(plan, changed, { packed: true }), []);
  changed['@plumbus/ui'].dependencies['@plumbus/core'] = changed['@plumbus/core'].version;
  assert.ok(
    releaseIssues(plan, changed, { packed: true }).some((issue) => issue.includes('shared peer')),
  );
});

test('rejects unresolved workspace dependencies in tarballs', () => {
  const changed = structuredClone(manifests);
  changed['@plumbus/ui'].peerDependencies['@plumbus/core'] = 'workspace:*';
  assert.ok(
    releaseIssues(plan, changed, { packed: true }).some((issue) => issue.includes('workspace:*')),
  );
});

test('rejects missing packages and release tags for an old line', () => {
  const changed = structuredClone(manifests);
  delete changed['@plumbus/mcp'];
  assert.ok(
    releaseIssues(plan, changed).some((issue) => issue.includes('missing package manifest')),
  );
  assert.ok(
    releaseIssues(plan, manifests, { tag: 'v0.6.20' }).some((issue) =>
      issue.includes('Release tag'),
    ),
  );
  assert.deepEqual(
    releaseIssues(plan, manifests, { tag: `v${manifests['@plumbus/core'].version}` }),
    [],
  );
});

test('rejects removing the core peer boundary from MCP or UI', () => {
  const changed = structuredClone(manifests);
  delete changed['@plumbus/mcp'].peerDependencies['@plumbus/core'];
  delete changed['@plumbus/ui'].peerDependencies['@plumbus/core'];
  const issues = releaseIssues(plan, changed);
  assert.ok(issues.some((issue) => issue.includes('missing required peer')));
  assert.ok(issues.some((issue) => issue.includes('@plumbus/ui: missing required peer')));
});
