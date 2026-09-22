#!/usr/bin/env node
/**
 * Compile-time regression for defineTranslation SameKeyMessages.
 *
 * - positive.ts must typecheck clean
 * - negative.ts must fail with the expected TS2741 / TS2739 diagnostics
 *
 * Requires a prior `pnpm build` so fixtures can import from dist/.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'src/define/__typecheck-fixtures');

function runTsc(configName) {
  const result = spawnSync(
    'pnpm',
    ['exec', 'tsc', '--noEmit', '-p', join(fixtures, configName)],
    {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function fail(message) {
  console.error(`check-define-translation-types: ${message}`);
  process.exit(1);
}

const positive = runTsc('tsconfig.positive.json');
if (positive.status !== 0) {
  fail(`positive fixtures must typecheck clean:\n${positive.stdout}${positive.stderr}`);
}

const negative = runTsc('tsconfig.negative.json');
if (negative.status === 0) {
  fail('negative fixtures unexpectedly typechecked clean — SameKeyMessages may be weakened');
}

const combined = `${negative.stdout}\n${negative.stderr}`;
const expectedSubstrings = [
  // missingOneKey — he missing farewell
  "Property 'farewell' is missing",
  // twoLocaleMutualMismatch — he missing greeting1, greeting2
  'greeting1, greeting2',
  // threeLocaleMutualMismatch — en missing goodbye, salut
  'goodbye, salut',
  // threeLocaleMutualMismatch — he missing farewell, salut
  'farewell, salut',
  // threeLocaleMutualMismatch — fr missing farewell, goodbye
  'farewell, goodbye',
];

const missing = expectedSubstrings.filter((s) => !combined.includes(s));
if (missing.length > 0) {
  fail(
    `negative fixtures failed, but expected diagnostics were missing:\n` +
      missing.map((s) => `  - ${s}`).join('\n') +
      `\n\nActual tsc output:\n${combined}`,
  );
}

console.log('check-define-translation-types: ok (positive clean, negative diagnostics match)');
