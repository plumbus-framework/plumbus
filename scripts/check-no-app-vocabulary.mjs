#!/usr/bin/env node
/**
 * check-no-app-vocabulary — framework boundary guard.
 *
 * Plumbus is a general, publishable framework. It provides MECHANISMS (tenants, data planes,
 * schemas, resolvers, provisioning); downstream applications provide their own POLICY and
 * VOCABULARY. Application-specific nouns must therefore never appear inside framework source or
 * framework tests: once they do, the framework silently becomes one application's private
 * runtime and can no longer be published or reused.
 *
 * This script fails the build when framework source under `packages/<pkg>/src` contains:
 *
 *   1. banned application identifiers — `quinovi`, `quinovium`, `education-platform`,
 *      `urn:quinovi` — matched case-insensitively ANYWHERE (code, strings, comments, filenames).
 *      These have no general-English meaning, so any occurrence is a leak.
 *
 *   2. application domain terms — institution, course, lecturer, student, submission,
 *      evaluation, rubric, grade, academic — matched only where they are used as NAMES
 *      (identifiers, type names, property keys, id/URN string literals, file paths), never where
 *      they are ordinary English words in prose. See "False-positive control" below.
 *
 * False-positive control
 * ----------------------
 * Several of the domain terms are also ordinary English words that appear legitimately in a
 * general framework. The matcher is built around three deliberate restrictions:
 *
 *   a) Segment equality, not substring. Every candidate name is split into segments on
 *      `-` `_` `/` `:` and camelCase/PascalCase/digit boundaries, and each segment is compared
 *      for EQUALITY against the term list. So `upgrade`, `upgrades`, `UpgradeOptions`,
 *      `registerUpgradeCommand`, `pre-upgrade`, `degraded`, `degrades` never match `grade`;
 *      `submitted`/`submitter` never match `submission`; `evaluator` never matches `evaluation`.
 *      This is what "word boundaries" means here. A plain substring scan would fire on every one
 *      of those; segment equality fires on none, while still catching `courseIntakeId`,
 *      `student_id`, `grade-participant` and `EVALUATION_FLOW_ID`.
 *
 *   b) Prose is excluded for bare words. A single-word occurrence (`Evaluation`, `submission`)
 *      only counts when it sits in a code-name position — a whole string literal, a declaration,
 *      a property key, a member access, or a binding list — and only after comments have been
 *      blanked out. That is why real framework prose such as
 *        "// -- Rule Evaluation Result --"
 *        "// -- Flow condition evaluation --"
 *        "Override condition evaluations by condition expression" (in a doc comment)
 *        "it('respects overrides in policy evaluation', ...)"
 *        "Evaluation time for expiry checks (defaults to now)." (in a doc comment)
 *      does not fire: "expression evaluation", "policy evaluation" and "lazy evaluation" are
 *      multiple space-separated words, and space is not a name joiner.
 *
 *   c) Documented neighbour qualifiers, for exactly two terms.
 *
 *      `evaluation` has a real framework-generic meaning (evaluating a condition, an expression,
 *      a rule, a policy, a chat scenario). A compound is exempted when the segment immediately
 *      before or after `evaluation` names a framework construct — see GENERIC_SENSE_QUALIFIERS.
 *      That exempts `runChatEvaluation`, `ChatEvaluationDefinition`, `run-evaluation.ts` and
 *      `reference-evaluations.test.ts` (the @plumbus/chat evaluation harness) while still firing
 *      on application compounds such as `assignment-evaluation/...`, `evaluation-report-version`,
 *      `evaluationReleaseId` or `EVALUATION_FLOW_BUDGET_PROFILE_ID`.
 *
 *      `grade` appears in the English adjectival compound "<quality>-grade" —
 *      "production-grade", "enterprise-grade", "partner-grade" all occur in this repository's
 *      prose. Only the segment immediately BEFORE `grade` is consulted, and only against
 *      ADJECTIVAL_GRADE_QUALIFIERS, so `gradeId`, `finalGrade` and `grade-participant` still
 *      fire. School-year ordinals are deliberately excluded from that list.
 *
 *      Both lists are short, every entry is justified above, and widening either is a visible
 *      diff that must be argued for. The remaining seven terms have no general sense in a
 *      framework and carry no exemptions at all.
 *
 * Known accepted risk: `formSubmission` — a genuinely generic web concept — would be reported.
 * No occurrence exists anywhere in this repository today, so no exemption is pre-granted; if one
 * appears, add `form` as a `submission` qualifier rather than weakening the rule.
 *
 * Usage
 * -----
 *   node scripts/check-no-app-vocabulary.mjs [--root <dir>] [--json] [--quiet] [--max <n>]
 *
 * Exit codes: 0 = clean, 1 = violations found, 2 = usage/IO error.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Term tables ────────────────────────────────────────────────────────────────────────────────

/**
 * Banned application identifiers. Ordered longest-first so the reported match is the most
 * specific one. Matched case-insensitively anywhere in content and in file paths.
 */
export const APP_IDENTIFIER_PATTERN =
  /urn:quinovi[A-Za-z0-9_.:-]*|quinovium|quinovi|education-platform/gi;

/**
 * Framework constructs whose evaluation is a general-purpose framework concern. Used ONLY to
 * exempt the term `evaluation`, and only when the qualifier is directly adjacent to it inside the
 * same compound name.
 */
export const GENERIC_SENSE_QUALIFIERS = new Set([
  'benchmark',
  'benchmarks',
  'chat',
  'condition',
  'conditions',
  'eager',
  'expression',
  'expressions',
  'guard',
  'guards',
  'harness',
  'lazy',
  'policies',
  'policy',
  'predicate',
  'predicates',
  'reference',
  'references',
  'rule',
  'rules',
  'run',
  'runner',
  'scenario',
  'scenarios',
  'spec',
  'specs',
  'suite',
  'suites',
  'template',
  'templates',
  'test',
  'tests',
]);

/**
 * English adjectival compounds of the form "<quality>-grade" — "production-grade retry logic",
 * "enterprise-grade isolation". These already occur in this repository's prose and would
 * otherwise be reported as the domain term `grade`. Only the segment IMMEDIATELY BEFORE `grade`
 * is consulted (an adjectival modifier always precedes), so `gradeId`, `finalGrade`,
 * `grade-participant` and `studentGrade` are unaffected.
 *
 * School-year ordinals ("first-grade", "second-grade") are deliberately absent: those ARE
 * application vocabulary.
 */
export const ADJECTIVAL_GRADE_QUALIFIERS = new Set([
  'aerospace',
  'aviation',
  'bug',
  'carrier',
  'commercial',
  'consumer',
  'enterprise',
  'high',
  'industrial',
  'investment',
  'low',
  'marine',
  'medical',
  'military',
  'partner',
  'pharmaceutical',
  'premium',
  'pro',
  'production',
  'professional',
  'research',
  'server',
  'weapons',
]);

/**
 * Application domain vocabulary. `forms` lists the surface forms compared for segment equality.
 *
 * `compoundOnly: true` means the term is only reported inside a multi-segment name, because the
 * bare word has a legitimate standalone use in this framework (see GENERIC_SENSE_QUALIFIERS).
 *
 * `qualifiers` / `qualifierSide` exempt a compound whose neighbouring segment proves a
 * general-English or framework-construct sense. The other seven terms carry no exemptions at
 * all: they have no general sense in a framework, so any name-shaped use is a leak.
 */
export const DOMAIN_TERMS = [
  { term: 'institution', forms: ['institution', 'institutions'] },
  { term: 'course', forms: ['course', 'courses'] },
  { term: 'lecturer', forms: ['lecturer', 'lecturers'] },
  { term: 'student', forms: ['student', 'students'] },
  { term: 'submission', forms: ['submission', 'submissions'] },
  {
    term: 'evaluation',
    forms: ['evaluation', 'evaluations'],
    compoundOnly: true,
    qualifiers: GENERIC_SENSE_QUALIFIERS,
    qualifierSide: 'both',
  },
  { term: 'rubric', forms: ['rubric', 'rubrics'] },
  {
    term: 'grade',
    forms: ['grade', 'grades'],
    qualifiers: ADJECTIVAL_GRADE_QUALIFIERS,
    qualifierSide: 'before',
  },
  { term: 'academic', forms: ['academic', 'academics'] },
];

const TERM_BY_FORM = new Map();
for (const entry of DOMAIN_TERMS) {
  for (const form of entry.forms) TERM_BY_FORM.set(form, entry);
}

// ── Traversal configuration ────────────────────────────────────────────────────────────────────

/** Directory names never scanned, anywhere in the tree. */
export const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

/**
 * Fixture directories explicitly named for a downstream-consumer test — a fixture that
 * deliberately carries an application's vocabulary because it exists to prove the framework can
 * host that application. Paths are repo-relative and must name a directory, never a package.
 *
 * Empty by design. Adding a row is a reviewable diff and requires a stated reason.
 */
export const CONSUMER_FIXTURE_DIRS = [];

/** Extensions whose content is scanned. Anything else is path-scanned only. */
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.css',
  '.graphql',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

/** Extensions whose comment syntax the stripper understands, enabling the bare-name rules. */
const CODE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.sql',
  '.ts',
  '.tsx',
]);

// ── Name segmentation ──────────────────────────────────────────────────────────────────────────

/**
 * Matches a compound-name candidate: alphanumeric runs joined by `-`, `_`, `/` or `:`.
 * `_` is part of the run itself so `snake_case` arrives as one span. `.` deliberately TERMINATES
 * a span (member access and file extensions are separate names, not one compound).
 */
const NAME_SPAN_PATTERN = /[A-Za-z0-9_$]+(?:[-/:][A-Za-z0-9_$]+)*/g;

/**
 * Split a name into lowercase segments on joiners and camelCase/PascalCase/digit boundaries.
 * `courseIntakeId` → [course, intake, id]; `EVALUATION_FLOW_ID` → [evaluation, flow, id];
 * `registerUpgradeCommand` → [register, upgrade, command] (never [.., grade, ..]).
 */
export function splitSegments(span) {
  const out = [];
  for (const part of span.split(/[-_/:]+/)) {
    if (!part) continue;
    const marked = part
      .replace(/([a-z0-9$])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([A-Za-z])([0-9])/g, '$1 $2')
      .replace(/([0-9])([A-Za-z])/g, '$1 $2');
    for (const piece of marked.split(' ')) {
      if (piece) out.push(piece.toLowerCase());
    }
  }
  return out;
}

function isQualifierExempt(entry, segments, index) {
  if (!entry.qualifiers) return false;
  const side = entry.qualifierSide ?? 'both';
  const before = side !== 'after' ? segments[index - 1] : undefined;
  const after = side !== 'before' ? segments[index + 1] : undefined;
  return (
    (before !== undefined && entry.qualifiers.has(before)) ||
    (after !== undefined && entry.qualifiers.has(after))
  );
}

// ── Comment blanking ───────────────────────────────────────────────────────────────────────────

/**
 * Replace comment bodies with spaces, preserving byte offsets and newlines so line/column
 * arithmetic stays valid. String literals are preserved: an id string is a name, a comment is not.
 * Handles line comments, block comments and (for .sql) double-dash comments.
 */
export function blankComments(source, { sql = false } = {}) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < n && source[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (sql && c === '-' && next === '-') {
      let j = i + 2;
      while (j < n && source[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
      const end = Math.min(n, j + 2);
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        if (c !== '`' && source[j] === '\n') break;
        j++;
      }
      i = Math.min(n, j + 1);
      continue;
    }
    i++;
  }
  return out.join('');
}

// ── Position helpers ───────────────────────────────────────────────────────────────────────────

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function positionAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

// ── Rules ──────────────────────────────────────────────────────────────────────────────────────

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Code-name positions for a bare, single-word occurrence. Each pattern captures the term in
 * group 1 so the reported column points at the word itself.
 */
function bareNamePatterns(form) {
  const t = escapeRegExp(form);
  return [
    { rule: 'string-literal', re: new RegExp(`(?:['"\`])\\s*(${t})\\s*(?:['"\`])`, 'gi') },
    {
      rule: 'declaration',
      re: new RegExp(
        `\\b(?:const|let|var|function|class|interface|type|enum|namespace|readonly)\\s+(${t})\\b`,
        'gi',
      ),
    },
    { rule: 'property-key', re: new RegExp(`(?:^|[{,;(])\\s*(${t})\\s*\\??\\s*:`, 'gim') },
    { rule: 'member-access', re: new RegExp(`\\.\\s*(${t})\\b`, 'gi') },
    { rule: 'binding-list', re: new RegExp(`[{,]\\s*(${t})\\s*[},]`, 'gi') },
  ];
}

const BARE_PATTERNS = new Map();
for (const entry of DOMAIN_TERMS) {
  if (entry.compoundOnly) continue;
  for (const form of entry.forms) BARE_PATTERNS.set(form, bareNamePatterns(form));
}

/**
 * Scan one text body. `mode` is 'content' or 'path'; `code` enables the bare-name rules.
 * Returns violations with 1-based line/column relative to `text`.
 */
export function scanText(text, { code = false, origin = 'content' } = {}) {
  const violations = [];
  const starts = lineStarts(text);
  const seen = new Set();
  const push = (offset, v) => {
    const { line, column } = positionAt(starts, offset);
    const key = `${line}:${column}:${v.rule}:${v.term}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ line, column, origin, ...v });
  };

  // Rule 1 — banned application identifiers, anywhere.
  APP_IDENTIFIER_PATTERN.lastIndex = 0;
  for (let m = APP_IDENTIFIER_PATTERN.exec(text); m; m = APP_IDENTIFIER_PATTERN.exec(text)) {
    push(m.index, {
      rule: 'app-identifier',
      term: m[0].toLowerCase().startsWith('urn:quinovi') ? 'urn:quinovi' : m[0].toLowerCase(),
      match: m[0],
      detail: 'banned application identifier — the framework must name no single application',
    });
  }

  // Rule 2a — domain terms as a segment of a compound name, anywhere (code, strings, comments).
  NAME_SPAN_PATTERN.lastIndex = 0;
  for (let m = NAME_SPAN_PATTERN.exec(text); m; m = NAME_SPAN_PATTERN.exec(text)) {
    const span = m[0];
    const segments = splitSegments(span);
    if (segments.length < 2) continue;
    for (let i = 0; i < segments.length; i++) {
      const entry = TERM_BY_FORM.get(segments[i]);
      if (!entry) continue;
      if (isQualifierExempt(entry, segments, i)) continue;
      push(m.index, {
        rule: 'compound-name',
        term: entry.term,
        match: span,
        detail: `application domain term "${entry.term}" used as a name segment`,
      });
    }
  }

  if (!code) return violations;

  // Rule 2b — bare domain terms in code-name positions, comments already blanked.
  for (const [form, patterns] of BARE_PATTERNS) {
    const entry = TERM_BY_FORM.get(form);
    for (const { rule, re } of patterns) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const offset = m.index + m[0].indexOf(m[1]);
        push(offset, {
          rule: `bare-name:${rule}`,
          term: entry.term,
          match: m[1],
          detail: `application domain term "${entry.term}" used as a name`,
        });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
  }
  return violations;
}

// ── File collection ────────────────────────────────────────────────────────────────────────────

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return acc;
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walk(full, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

/** Scan roots: `<root>/packages/<pkg>/src` for every package directory that has a `src`. */
export function collectScanRoots(root) {
  const packagesDir = join(root, 'packages');
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const src = join(packagesDir, entry.name, 'src');
    try {
      if (statSync(src).isDirectory()) roots.push(src);
    } catch {
      // package without a src directory
    }
  }
  return roots.sort();
}

function isConsumerFixture(relPath) {
  return CONSUMER_FIXTURE_DIRS.some(
    (dir) => relPath === dir || relPath.startsWith(dir.endsWith('/') ? dir : `${dir}/`),
  );
}

export function collectFiles(root) {
  const files = [];
  for (const scanRoot of collectScanRoots(root)) {
    for (const full of walk(scanRoot, [])) {
      const relPath = relative(root, full).split(sep).join('/');
      if (isConsumerFixture(relPath)) continue;
      files.push({ full, relPath });
    }
  }
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ── Driver ─────────────────────────────────────────────────────────────────────────────────────

export function checkRepository(root) {
  const files = collectFiles(root);
  const findings = [];
  let scannedContent = 0;
  let pathOnly = 0;

  for (const { full, relPath } of files) {
    for (const v of scanText(relPath, { code: false, origin: 'path' })) {
      findings.push({ file: relPath, ...v, line: 0, column: v.column });
    }

    const ext = extensionOf(relPath);
    if (!TEXT_EXTENSIONS.has(ext)) {
      pathOnly++;
      continue;
    }
    scannedContent++;

    let source;
    try {
      source = readFileSync(full, 'utf8');
    } catch (error) {
      throw new Error(`cannot read ${relPath}: ${error.message}`);
    }
    const isCode = CODE_EXTENSIONS.has(ext);
    const body = isCode ? blankComments(source, { sql: ext === '.sql' }) : source;
    // Rule 1 and 2a read the original text (comments included); 2b reads the blanked body.
    const commentAware = scanText(source, { code: false, origin: 'content' });
    const codeOnly = isCode
      ? scanText(body, { code: true, origin: 'content' }).filter((v) =>
          v.rule.startsWith('bare-name:'),
        )
      : [];
    for (const v of [...commentAware, ...codeOnly]) findings.push({ file: relPath, ...v });
  }

  findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
  return { root, files: files.length, scannedContent, pathOnly, findings };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { root: undefined, json: false, quiet: false, max: 200 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') options.root = argv[++i];
    else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length);
    else if (arg === '--json') options.json = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--max') options.max = Number(argv[++i]);
    else if (arg.startsWith('--max=')) options.max = Number(arg.slice('--max='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const USAGE = `Usage: node scripts/check-no-app-vocabulary.mjs [options]

  --root <dir>   repository root to scan (default: the repo containing this script)
  --json         emit the full result as JSON on stdout
  --quiet        print only the summary line
  --max <n>      cap the number of printed findings (default 200)
  -h, --help     show this message

Scans <root>/packages/*/src for application-specific vocabulary. Exit 1 on any finding.`;

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`check-no-app-vocabulary: ${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(options.root ?? join(here, '..'));

  let result;
  try {
    result = checkRepository(root);
  } catch (error) {
    process.stderr.write(`check-no-app-vocabulary: ${error.message}\n`);
    return 2;
  }

  // A gate that scanned nothing must never report "clean": a wrong root or a renamed directory
  // would otherwise pass vacuously.
  if (result.files === 0) {
    process.stderr.write(
      `check-no-app-vocabulary: scanned 0 files — no packages/*/src found under ${root}. ` +
        'Refusing to report a clean result from an empty scan.\n',
    );
    return 2;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.findings.length > 0 ? 1 : 0;
  }

  const { findings, files, scannedContent, pathOnly } = result;
  if (findings.length === 0) {
    if (!options.quiet) {
      process.stdout.write(
        `check-no-app-vocabulary: ok — no application vocabulary in ${scannedContent} scanned ` +
          `files (${files} total, ${pathOnly} path-only) under ${root}/packages/*/src\n`,
      );
    }
    return 0;
  }

  if (!options.quiet) {
    process.stderr.write(
      'check-no-app-vocabulary: FAILED — Plumbus is a general framework and must not name a\n' +
        'single application. Replace these with generic framework terms (tenant, data plane,\n' +
        'schema, resolver, provisioning) or move the concept into the consuming application.\n\n',
    );
    const shown = findings.slice(0, options.max);
    for (const f of shown) {
      const where = f.origin === 'path' ? `${f.file} (file path)` : `${f.file}:${f.line}:${f.column}`;
      process.stderr.write(`  ${where}\n    [${f.rule}] ${f.term} — ${f.detail}\n      ${f.match}\n`);
    }
    if (findings.length > shown.length) {
      process.stderr.write(`  … ${findings.length - shown.length} more finding(s) not shown\n`);
    }
    process.stderr.write('\n');
  }

  const affected = new Set(findings.map((f) => f.file)).size;
  process.stderr.write(
    `check-no-app-vocabulary: ${findings.length} finding(s) in ${affected} file(s) ` +
      `(${scannedContent} files scanned under ${root}/packages/*/src)\n`,
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
