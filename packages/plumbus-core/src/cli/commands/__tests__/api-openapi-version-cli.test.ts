import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The CLI imports @plumbus/api dynamically (optional peer). Replacing the module here lets the
// action run end to end — Commander parsing through to the file on disk — without a real app.
const generateOpenApiCalls: { options: unknown }[] = [];
const diffCalls: { prev: { openapi?: string }; next: { openapi?: string } }[] = [];

vi.mock('@plumbus/api', () => ({
  parseManifest: () => ({ name: 'partner-api' }),
  buildDefaultManifest: () => ({ name: 'partner-api', basePath: '/api/v1', expose: [] }),
  generateOpenApi: (_caps: unknown, _manifest: unknown, options?: { version?: string }) => {
    generateOpenApiCalls.push({ options });
    return { openapi: options?.version ?? '3.0.3', info: {}, paths: {} };
  },
  serializeOpenApiDocument: (doc: unknown) => JSON.stringify(doc, null, 2),
  parseOpenApiDocument: (source: string) => JSON.parse(source),
  diffOpenApi: (prev: { openapi?: string }, next: { openapi?: string }) => {
    diffCalls.push({ prev, next });
    return prev.openapi === next.openapi
      ? { breaking: [], nonBreaking: [] }
      : {
          breaking: [],
          nonBreaking: [
            {
              kind: 'changed-openapi-version',
              message: `OpenAPI document version changed ${prev.openapi} → ${next.openapi}`,
            },
          ],
        };
  },
  generateApiDocs: () => new Map<string, string>(),
  validateApiContract: async () => ({ manifest: [], policy: [], pathParams: [], fixtures: [] }),
  validateTestFixtures: async () => [],
}));

const { registerApiCommand } = await import('../api.js');

let outDir: string;
let exitSpy: ReturnType<typeof vi.spyOn>;

class ProcessExitCalled extends Error {
  readonly code: number | undefined;
  constructor(code: number | undefined) {
    super(`process.exit(${String(code)})`);
    this.code = code;
  }
}

beforeEach(() => {
  generateOpenApiCalls.length = 0;
  diffCalls.length = 0;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plumbus-openapi-version-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitCalled(code);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  fs.rmSync(outDir, { recursive: true, force: true });
});

async function runApi(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerApiCommand(program);
  await program.parseAsync(['node', 'plumbus', 'api', ...args]);
}

async function runGenerate(args: string[]): Promise<void> {
  await runApi(['generate', 'openapi', ...args]);
}

describe('plumbus api generate openapi (action)', () => {
  it('emits 3.0.3 by default and tells the generator so', async () => {
    const out = path.join(outDir, 'openapi.json');
    await runGenerate(['--out', out]);

    expect(generateOpenApiCalls).toEqual([{ options: { version: '3.0.3' } }]);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).openapi).toBe('3.0.3');
  });

  it('passes --openapi-version 3.1.0 through to the generator and writes that document', async () => {
    const out = path.join(outDir, 'openapi-31.json');
    await runGenerate(['--out', out, '--openapi-version', '3.1.0']);

    expect(generateOpenApiCalls).toEqual([{ options: { version: '3.1.0' } }]);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).openapi).toBe('3.1.0');
  });

  it('exits 1 on an unsupported version without calling the generator', async () => {
    const out = path.join(outDir, 'unused.json');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runGenerate(['--out', out, '--openapi-version', '3.2.0'])).rejects.toBeInstanceOf(
      ProcessExitCalled,
    );

    expect(generateOpenApiCalls).toEqual([]);
    expect(fs.existsSync(out)).toBe(false);
    expect(error.mock.calls.flat().join('\n')).toContain('Unsupported OpenAPI version "3.2.0"');
    error.mockRestore();
  });
});

describe('plumbus api diff across document versions', () => {
  function writeBaseline(version: string): string {
    const baseline = path.join(outDir, `openapi-${version}.json`);
    fs.writeFileSync(
      baseline,
      JSON.stringify({ openapi: version, info: { title: 'partner-api' }, paths: {} }),
      'utf-8',
    );
    return baseline;
  }

  it('compares a 3.0.3 baseline against a 3.1.0 current spec without exiting non-zero', async () => {
    const baseline = writeBaseline('3.0.3');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApi(['diff', '--against', baseline, '--openapi-version', '3.1.0']);

    expect(diffCalls).toHaveLength(1);
    expect(diffCalls[0]?.prev.openapi).toBe('3.0.3');
    expect(diffCalls[0]?.next.openapi).toBe('3.1.0');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('3.0.3 → 3.1.0');
    log.mockRestore();
  });

  it('generates the current spec at the baseline version when asked, leaving no version change', async () => {
    const baseline = writeBaseline('3.1.0');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApi(['diff', '--against', baseline, '--openapi-version', '3.1.0']);

    expect(diffCalls[0]?.prev.openapi).toBe('3.1.0');
    expect(diffCalls[0]?.next.openapi).toBe('3.1.0');
    expect(exitSpy).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('defaults the current spec to 3.0.3', async () => {
    const baseline = writeBaseline('3.0.3');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runApi(['diff', '--against', baseline]);

    expect(generateOpenApiCalls).toEqual([{ options: { version: '3.0.3' } }]);
    expect(diffCalls[0]?.next.openapi).toBe('3.0.3');
    log.mockRestore();
  });
});
