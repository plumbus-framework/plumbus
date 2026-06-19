/**
 * Emits voice CLI dist files that tsc -b cannot reliably refresh in this package
 * (TS5055 dist overwrite). Required for LiveKit child-process bootstrap:
 * dist/cli/voice-agent-bootstrap.js
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const esbuildBin = join(packageRoot, 'node_modules', '.bin', 'esbuild');
const esbuildCmd = existsSync(esbuildBin) ? esbuildBin : 'esbuild';

const targets = [
  {
    entry: 'src/cli/mcp-serve-context.ts',
    outfile: 'dist/cli/mcp-serve-context.js',
  },
  {
    entry: 'src/cli/voice-serve-context.ts',
    outfile: 'dist/cli/voice-serve-context.js',
  },
  {
    entry: 'src/cli/voice-agent-bootstrap.ts',
    outfile: 'dist/cli/voice-agent-bootstrap.js',
  },
  {
    entry: 'src/cli/commands/voice.ts',
    outfile: 'dist/cli/commands/voice.js',
  },
];

for (const target of targets) {
  const result = spawnSync(
    esbuildCmd,
    [
      target.entry,
      `--outfile=${target.outfile}`,
      '--format=esm',
      '--platform=node',
      '--packages=external',
    ],
    {
      cwd: packageRoot,
      stdio: 'inherit',
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
