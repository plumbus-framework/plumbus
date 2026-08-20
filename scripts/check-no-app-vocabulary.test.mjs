#!/usr/bin/env node
/**
 * Tests for check-no-app-vocabulary.
 *
 * Run with: node --test scripts/check-no-app-vocabulary.test.mjs
 *
 * NOTE: this file deliberately contains the banned vocabulary as test data. It lives in
 * `scripts/`, which the checker never scans — the checker's scan roots are `packages/<pkg>/src`
 * only. If the scan roots are ever widened, this file must be added to CONSUMER_FIXTURE_DIRS or
 * moved, and that is a reviewable diff by design.
 *
 * The "must not fire" cases are copied verbatim from real lines in this repository, so the suite
 * is the false-positive control for the rules, not a hypothetical.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  blankComments,
  checkRepository,
  collectScanRoots,
  scanText,
  splitSegments,
} from './check-no-app-vocabulary.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

/** Scan a TypeScript-shaped body exactly as checkRepository does for a `.ts` file. */
function scanSource(source) {
  const commentAware = scanText(source, { code: false, origin: 'content' });
  const bare = scanText(blankComments(source), { code: true, origin: 'content' }).filter((v) =>
    v.rule.startsWith('bare-name:'),
  );
  return [...commentAware, ...bare];
}

const terms = (findings) => [...new Set(findings.map((f) => f.term))].sort();

// ── Segmentation ───────────────────────────────────────────────────────────────────────────────

describe('splitSegments', () => {
  it('splits camelCase, PascalCase, snake_case, kebab-case, paths and URNs', () => {
    assert.deepEqual(splitSegments('courseIntakeId'), ['course', 'intake', 'id']);
    assert.deepEqual(splitSegments('EVALUATION_FLOW_BUDGET_PROFILE_ID'), [
      'evaluation',
      'flow',
      'budget',
      'profile',
      'id',
    ]);
    assert.deepEqual(splitSegments('assignment-evaluation/analyze-submission'), [
      'assignment',
      'evaluation',
      'analyze',
      'submission',
    ]);
    assert.deepEqual(splitSegments('__fixtures__/reference-evaluations'), [
      'fixtures',
      'reference',
      'evaluations',
    ]);
    assert.deepEqual(splitSegments('HTTPServerOptions'), ['http', 'server', 'options']);
  });

  it('never produces "grade" from the upgrade/degrade family', () => {
    for (const name of [
      'upgrade',
      'upgrades',
      'UpgradeOptions',
      'registerUpgradeCommand',
      'UPGRADE_INSTRUCTIONS',
      'pre-upgrade',
      'degraded',
      'degrades',
      'downgrade',
      'degradation',
    ]) {
      assert.ok(!splitSegments(name).includes('grade'), `${name} must not yield a "grade" segment`);
      assert.ok(
        !splitSegments(name).includes('grades'),
        `${name} must not yield a "grades" segment`,
      );
    }
  });

  it('never produces "submission" from submitted/submitter', () => {
    assert.ok(!splitSegments('submittedAt').includes('submission'));
    assert.ok(!splitSegments('submitter-id').includes('submission'));
  });
});

// ── Comment blanking ───────────────────────────────────────────────────────────────────────────

describe('blankComments', () => {
  it('blanks line and block comments while preserving offsets, newlines and strings', () => {
    const source = ["const a = 'keep'; // drop", '/* drop', '   still dropping */ const b = 1;'].join(
      '\n',
    );
    const blanked = blankComments(source);
    assert.equal(blanked.length, source.length);
    assert.equal(blanked.split('\n').length, source.split('\n').length);
    assert.ok(blanked.includes("'keep'"));
    assert.ok(!blanked.includes('drop'));
    assert.ok(blanked.includes('const b = 1;'));
  });

  it('does not treat a URL inside a string as a line comment', () => {
    const blanked = blankComments("const u = 'https://example.test/student';");
    assert.ok(blanked.includes('student'));
  });

  it('blanks double-dash comments only for SQL', () => {
    assert.ok(!blankComments('select 1; -- student', { sql: true }).includes('student'));
    assert.ok(blankComments('const x = 1; -- student').includes('student'));
  });
});

// ── Rule 1: banned application identifiers ─────────────────────────────────────────────────────

describe('banned application identifiers', () => {
  it('fires on quinovi, quinovium, urn:quinovi and education-platform anywhere', () => {
    const cases = [
      "const id = 'urn:quinovi:education-platform:contract:x';",
      '// TODO: align with Quinovium naming',
      "import { thing } from '@quinovi/sdk-ai';",
      "const contract = 'education-platform';",
    ];
    for (const source of cases) {
      const found = scanSource(source).filter((f) => f.rule === 'app-identifier');
      assert.ok(found.length > 0, `expected an app-identifier finding for: ${source}`);
    }
  });

  it('reports a whole URN as one urn:quinovi finding rather than several fragments', () => {
    const found = scanSource("'urn:quinovi:education-platform:contract:x'").filter(
      (f) => f.rule === 'app-identifier',
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].term, 'urn:quinovi');
    assert.equal(found[0].match, 'urn:quinovi:education-platform:contract:x');
  });

  it('reports a bare education-platform on its own', () => {
    const found = scanSource("const contractNamespace = 'education-platform';").filter(
      (f) => f.rule === 'app-identifier',
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].term, 'education-platform');
  });

  it('fires even inside comments', () => {
    const found = scanSource('// quinovium owns this, not the framework');
    assert.equal(found.filter((f) => f.rule === 'app-identifier').length, 1);
  });
});

// ── Rule 2a: domain terms as name segments ─────────────────────────────────────────────────────

describe('domain terms in compound names', () => {
  it('fires on identifier, type, constant and id-string forms', () => {
    const cases = [
      ['const courseIntakeId = 1;', 'course'],
      ['interface InstitutionRef { id: string }', 'institution'],
      ['const student_id = row.id;', 'student'],
      ['type LecturerProfile = { id: string };', 'lecturer'],
      ["const p = 'assignment-evaluation/analyze-submission';", 'submission'],
      ['const evaluationReleaseId = x;', 'evaluation'],
      ["const BUDGET = 'platform/evaluation-flow';", 'evaluation'],
      ['export const EVALUATION_FLOW_BUDGET_PROFILE_ID = 1;', 'evaluation'],
      ["permittedDataClassIds: ['academic/submission']", 'academic'],
      ["const prompt = 'grade-guideline-section';", 'grade'],
      ['const rubricSetId = x;', 'rubric'],
    ];
    for (const [source, term] of cases) {
      assert.ok(
        terms(scanSource(source)).includes(term),
        `expected "${term}" for: ${source} (got ${JSON.stringify(terms(scanSource(source)))})`,
      );
    }
  });

  it('fires on domain vocabulary in file paths', () => {
    const found = scanText('packages/plumbus-core/src/academic-structure/index.ts', {
      code: false,
      origin: 'path',
    });
    assert.deepEqual(terms(found), ['academic']);
  });
});

// ── False-positive control ─────────────────────────────────────────────────────────────────────

describe('false positives', () => {
  it('does not fire on framework prose containing "evaluation"', () => {
    const cases = [
      '// -- Rule Evaluation Result --',
      '// -- Flow condition evaluation --',
      '/** Override condition evaluations by condition expression */',
      "it('respects overrides in policy evaluation', () => {});",
      '/** Evaluation time for expiry checks (defaults to now). */',
      '// lazy evaluation of the expression is deferred until first read',
      '// short-circuit evaluation stops at the first false condition',
      '/** Policy evaluation happens before the handler runs. */',
    ];
    for (const source of cases) {
      assert.deepEqual(scanSource(source), [], `unexpected finding for: ${source}`);
    }
  });

  it('does not fire on the chat evaluation harness surface', () => {
    const cases = [
      "export { runChatEvaluation } from './eval/run-evaluation.js';",
      "export { runChatEvaluation } from './run-evaluation.js';",
      'export async function runChatEvaluation(evaluation: ChatEvaluationDefinition) {}',
      '  for (const scenario of evaluation.scenarios) {',
      '        chatDefinition: evaluation.chat,',
      "import { runChatEvaluation } from '../run-evaluation.js';",
      "} from '../__fixtures__/reference-evaluations.js';",
      "describe('reference chat evaluations', () => {});",
    ];
    for (const source of cases) {
      assert.deepEqual(scanSource(source), [], `unexpected finding for: ${source}`);
    }
  });

  it('does not fire on the upgrade/degrade family', () => {
    const cases = [
      'import { registerUpgradeCommand } from "./commands/upgrade.js";',
      "  status: 'degraded',",
      'interface UpgradeOptions { force?: boolean }',
      "expect(commandNames).toContain('upgrade');",
      '// consumers who upgrade `@plumbus/core` get the new path',
      '// this path is degraded; alignment happens on the next tick',
      'const UPGRADE_INSTRUCTIONS = 1;',
      '// always created with a real hash; the default only backs pre-upgrade rows.',
    ];
    for (const source of cases) {
      assert.deepEqual(scanSource(source), [], `unexpected finding for: ${source}`);
    }
  });

  it('does not fire on the English "<quality>-grade" adjectival compound', () => {
    const cases = [
      '// production-grade retry logic with jitter',
      '/** Enterprise-grade tenant isolation. */',
      "const note = 'partner-grade support';",
      '// Production-grade streaming transcription',
      '// this is Not-a-bug-grade severity',
      '// high-grade entropy source',
      'const label = "military-grade encryption";',
    ];
    for (const source of cases) {
      assert.deepEqual(scanSource(source), [], `unexpected finding for: ${source}`);
    }
  });

  it('still fires on grade compounds that are not the adjectival form', () => {
    for (const [source, expected] of [
      ["const p = 'grade-participant';", ['grade']],
      ['const gradeId = 1;', ['grade']],
      ['const finalGrade = 1;', ['grade']],
      ["const p = 'grade-guideline-section';", ['grade']],
      ['const firstGrade = 1;', ['grade']],
      ['const gradeProduction = 1;', ['grade']],
    ]) {
      assert.deepEqual(terms(scanSource(source)), expected, `expected a finding for: ${source}`);
    }
  });

  it('does not fire on bare domain words used as English prose in comments', () => {
    const cases = [
      '// of course this only holds while the lease is live',
      '// handle form submission before the redirect',
      '/* the institution of a new epoch is out of scope */',
    ];
    for (const source of cases) {
      assert.deepEqual(scanSource(source), [], `unexpected finding for: ${source}`);
    }
  });

  it('does not fire on non-domain lookalikes', () => {
    const cases = [
      'const evaluator = makeEvaluator();',
      'const submittedAt = new Date();',
      'const studious = false;',
      'const coursed = 1;',
      'const academy = 1;',
    ];
    for (const source of cases) {
      assert.deepEqual(scanSource(source), [], `unexpected finding for: ${source}`);
    }
  });
});

// ── Rule 2b: bare domain terms in code-name positions ──────────────────────────────────────────

describe('bare domain terms in code positions', () => {
  it('fires on id string literals, declarations, keys, member access and bindings', () => {
    const cases = [
      ["targetResources: [{ resourceTypeId: 'submission' }]", 'submission'],
      ['const student = row;', 'student'],
      ['type Rubric = { id: string };', 'rubric'],
      ['{ institution: true }', 'institution'],
      ['const x = record.lecturer;', 'lecturer'],
      ["import { course } from './x.js';", 'course'],
    ];
    for (const [source, term] of cases) {
      assert.ok(
        terms(scanSource(source)).includes(term),
        `expected "${term}" for: ${source} (got ${JSON.stringify(terms(scanSource(source)))})`,
      );
    }
  });

  it('does not fire on a bare "evaluation" identifier, which has a generic framework sense', () => {
    assert.deepEqual(scanSource('const evaluation = build();'), []);
    assert.deepEqual(scanSource("const kind = 'evaluation';"), []);
    assert.deepEqual(scanSource('return evaluation;'), []);
  });

  it('still fires on an unqualified "evaluation" compound, which needs a rename or a qualifier', () => {
    assert.deepEqual(terms(scanSource('const evaluationRecord = 1;')), ['evaluation']);
  });
});

// ── Repository driver ──────────────────────────────────────────────────────────────────────────

describe('checkRepository', () => {
  const roots = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function makeRepo(files) {
    const root = mkdtempSync(join(tmpdir(), 'plumbus-vocab-'));
    roots.push(root);
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(root, relPath);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    return root;
  }

  it('passes on a framework-shaped tree with only generic vocabulary', () => {
    const root = makeRepo({
      'packages/core/src/index.ts': [
        '// -- Rule Evaluation Result --',
        "export { runChatEvaluation } from './eval/run-evaluation.js';",
        'export interface DataPlaneResolver {',
        '  resolve(tenantRef: string): { db: unknown; coreSchema: string };',
        '}',
        'export const provisionTenant = () => undefined;',
        '',
      ].join('\n'),
      'packages/core/src/eval/run-evaluation.ts': [
        '/** Override condition evaluations by condition expression */',
        'export function runChatEvaluation(evaluation: ChatEvaluationDefinition) {',
        '  return evaluation.scenarios;',
        '}',
        '',
      ].join('\n'),
    });
    const result = checkRepository(root);
    assert.deepEqual(result.findings, []);
    assert.equal(result.scannedContent, 2);
  });

  it('fails on contaminated content and reports file, line and term', () => {
    const root = makeRepo({
      'packages/core/src/contaminated.ts': [
        'const x = 1;',
        "const courseId = 'urn:quinovi:education-platform:contract:x';",
        '',
      ].join('\n'),
    });
    const result = checkRepository(root);
    assert.ok(result.findings.length >= 2);
    assert.deepEqual(terms(result.findings), ['course', 'urn:quinovi']);
    for (const f of result.findings) {
      assert.equal(f.file, 'packages/core/src/contaminated.ts');
      assert.equal(f.line, 2);
    }
  });

  it('fails on domain vocabulary in a file path even for a non-text file', () => {
    const root = makeRepo({ 'packages/core/src/student-roster/sample.wav': 'not audio' });
    const result = checkRepository(root);
    assert.deepEqual(terms(result.findings), ['student']);
    assert.equal(result.pathOnly, 1);
    assert.equal(result.findings[0].origin, 'path');
  });

  it('never descends into node_modules or dist', () => {
    const root = makeRepo({
      'packages/core/src/ok.ts': 'export const a = 1;\n',
      'packages/core/src/node_modules/dep/index.ts': "export const studentId = 'x';\n",
      'packages/core/src/dist/index.js': "export const studentId = 'x';\n",
    });
    const result = checkRepository(root);
    assert.deepEqual(result.findings, []);
    assert.equal(result.files, 1);
  });

  it('ignores packages without a src directory and returns no roots for an empty tree', () => {
    const root = makeRepo({ 'packages/tooling/package.json': '{}\n' });
    assert.deepEqual(collectScanRoots(root), []);
    assert.deepEqual(checkRepository(root).findings, []);
  });
});

describe('CLI contract', () => {
  const roots = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const SCRIPT = join(SCRIPTS_DIR, 'check-no-app-vocabulary.mjs');
  const run = (args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO_ROOT });

  function makeRepo(files) {
    const root = mkdtempSync(join(tmpdir(), 'plumbus-vocab-cli-'));
    roots.push(root);
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(root, relPath);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    return root;
  }

  it('exits 0 on a clean tree', () => {
    const root = makeRepo({ 'packages/core/src/index.ts': 'export const a = 1;\n' });
    const r = run(['--root', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok — no application vocabulary/);
  });

  it('exits 1 on a contaminated tree and names the file on stderr', () => {
    const root = makeRepo({
      'packages/core/src/bad.ts': "export const courseId = 'urn:quinovi:contract:x';\n",
    });
    const r = run(['--root', root]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /packages\/core\/src\/bad\.ts/);
    assert.match(r.stderr, /course/);
    assert.match(r.stderr, /urn:quinovi/);
  });

  it('exits 2 rather than reporting clean when it scanned nothing', () => {
    const r = run(['--root', join(tmpdir(), 'plumbus-vocab-does-not-exist')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /scanned 0 files/);
    assert.doesNotMatch(r.stdout, /ok —/);
  });

  it('exits 2 on an unknown argument and prints usage', () => {
    const r = run(['--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown argument: --bogus/);
    assert.match(r.stderr, /Usage:/);
  });

  it('exits 0 for --help', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
  });

  it('emits deterministic JSON for the same tree', () => {
    const root = makeRepo({
      'packages/core/src/bad.ts': "export const studentId = 'x';\nexport const rubricId = 'y';\n",
    });
    const a = run(['--root', root, '--json']);
    const b = run(['--root', root, '--json']);
    assert.equal(a.status, 1);
    assert.equal(a.stdout, b.stdout);
    assert.deepEqual(terms(JSON.parse(a.stdout).findings), ['rubric', 'student']);
  });
});

describe('this repository', () => {
  it('discovers plumbus-core as a scan root', () => {
    const found = collectScanRoots(REPO_ROOT).map((p) => p.replaceAll('\\', '/'));
    assert.ok(
      found.some((p) => p.endsWith('/packages/plumbus-core/src')),
      `expected plumbus-core in scan roots, got ${JSON.stringify(found)}`,
    );
  });
});
