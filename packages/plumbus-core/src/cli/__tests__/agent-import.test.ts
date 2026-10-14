import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAgentWiring } from '../commands/doctor.js';
import {
  AGENT_WIRING_VERSION,
  generateAgentsMd,
  generateClaudeMd,
  hasAgentFileImport,
  writeAgentFiles,
} from '../commands/init.js';

describe('canonical agent instructions', () => {
  let root: string;
  const read = (name: string) => readFileSync(join(root, name), 'utf8');
  const write = (name: string, content: string) => writeFileSync(join(root, name), content);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plumbus-canonical-instructions-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])('creates both files for Claude-only setup with inline=%s', (inline) => {
    for (const monorepo of [false, true]) {
      const results = writeAgentFiles(
        root,
        ['claude', 'agents-md'],
        inline,
        false,
        monorepo,
        'force',
      );
      expect(results.map((item) => item.path)).toEqual(['AGENTS.md', 'CLAUDE.md']);
      expect(read('CLAUDE.md')).toBe(generateClaudeMd(inline, monorepo));
      expect(read('AGENTS.md')).toBe(generateAgentsMd(inline, monorepo));
      expect(read('AGENTS.md')).toContain(
        monorepo ? 'backend/app/capabilities/' : 'app/capabilities/',
      );
      if (inline) expect(read('AGENTS.md')).toContain('Vitest **5.0.4**');
      expect(checkAgentWiring().status).toBe('ok');
    }
  });

  it('migrates v20 clones while preserving each file’s app-owned notes', () => {
    const old = generateAgentsMd(false).replace(`version=${AGENT_WIRING_VERSION}`, 'version=20');
    write('AGENTS.md', `Shared preface\n${old}\nShared footer`);
    write(
      'CLAUDE.md',
      `Claude preface\n${old.replaceAll('AGENTS.md', 'CLAUDE.md').replace('format=agents-md', 'format=claude')}\nClaude footer`,
    );
    expect(checkAgentWiring().status).toBe('warn');
    writeAgentFiles(root, ['claude'], false, false, false, 'patch');
    expect(read('AGENTS.md')).toBe(`Shared preface\n${generateAgentsMd(false)}\nShared footer`);
    expect(read('CLAUDE.md')).toBe(`Claude preface\n${generateClaudeMd(false)}\nClaude footer`);
    expect(checkAgentWiring().status).toBe('ok');
    expect(
      writeAgentFiles(root, ['claude'], false, false, false, 'patch').every(
        (item) => item.action === 'unchanged',
      ),
    ).toBe(true);
  });

  it('creates the canonical target when migrating a Claude-only legacy setup', () => {
    write(
      'CLAUDE.md',
      generateAgentsMd(false)
        .replaceAll('AGENTS.md', 'CLAUDE.md')
        .replace('format=agents-md', 'format=claude')
        .replace(`version=${AGENT_WIRING_VERSION}`, 'version=20'),
    );
    writeAgentFiles(root, ['claude'], false, false, false, 'patch');
    expect(read('AGENTS.md')).toBe(generateAgentsMd(false));
    expect(read('CLAUDE.md')).toBe(generateClaudeMd(false));
  });

  it.each([
    'create',
    'patch',
  ] as const)('adds guidance to custom AGENTS.md without losing its contents in %s mode', (mode) => {
    write('AGENTS.md', '# App policy\nPreserve this exact text.');
    writeAgentFiles(root, ['claude'], false, false, false, mode);
    expect(read('AGENTS.md')).toBe(
      `# App policy\nPreserve this exact text.\n\n${generateAgentsMd(false)}`,
    );
    expect(read('CLAUDE.md')).toBe(generateClaudeMd(false));
    expect(checkAgentWiring().status).toBe('ok');
  });

  it('keeps a legacy Claude file when the canonical managed block is malformed', () => {
    write(
      'AGENTS.md',
      '<!-- plumbus:agent-wiring version=20 format=agents-md -->\nIncomplete block',
    );
    const legacy = generateAgentsMd(false).replaceAll('AGENTS.md', 'CLAUDE.md');
    write('CLAUDE.md', legacy);
    const results = writeAgentFiles(root, ['claude'], false, false, false, 'patch');
    expect(results.every((item) => item.action === 'skipped')).toBe(true);
    expect(read('CLAUDE.md')).toBe(legacy);
  });

  it('plans both missing files without writing them in dry-run mode', () => {
    const results = writeAgentFiles(root, ['claude'], true, false, false, 'patch', true);
    expect(results.map((item) => [item.path, item.action])).toEqual([
      ['AGENTS.md', 'created'],
      ['CLAUDE.md', 'created'],
    ]);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('refuses a reverse import instead of introducing a cycle', () => {
    write('AGENTS.md', '@CLAUDE.md\n');
    write('CLAUDE.md', 'Original shared instructions');
    const results = writeAgentFiles(root, ['claude'], false, false, false, 'force');
    expect(results.every((item) => item.action === 'skipped')).toBe(true);
    expect(read('AGENTS.md')).toBe('@CLAUDE.md\n');
    expect(read('CLAUDE.md')).toBe('Original shared instructions');
  });

  it('preserves a Claude symlink and never writes the import through it into AGENTS.md', () => {
    write(
      'AGENTS.md',
      generateAgentsMd(false).replace(`version=${AGENT_WIRING_VERSION}`, 'version=20'),
    );
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    const results = writeAgentFiles(root, ['claude'], false, false, false, 'patch');
    expect(results.find((item) => item.path === 'CLAUDE.md')?.action).toBe('skipped');
    expect(lstatSync(join(root, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(read('AGENTS.md')).toBe(generateAgentsMd(false));
    expect(checkAgentWiring().status).toBe('ok');
  });

  it('does not convert Claude when AGENTS.md is a link back to it', () => {
    const legacy = generateAgentsMd(false).replaceAll('AGENTS.md', 'CLAUDE.md');
    write('CLAUDE.md', legacy);
    symlinkSync('CLAUDE.md', join(root, 'AGENTS.md'));
    const results = writeAgentFiles(root, ['claude'], false, false, false, 'patch');
    expect(results.every((item) => item.action === 'skipped')).toBe(true);
    expect(read('CLAUDE.md')).toBe(legacy);
    expect(lstatSync(join(root, 'AGENTS.md')).isSymbolicLink()).toBe(true);
  });

  it('doctor reports dangling instruction symlinks', () => {
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    expect(checkAgentWiring()).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('dangling symbolic link'),
    });
  });

  it('doctor accepts a manual import of app-owned canonical instructions', () => {
    write('AGENTS.md', '# App instructions\nUse Plumbus capabilities.');
    write('CLAUDE.md', '@./AGENTS.md\n\nClaude-specific notes');
    expect(checkAgentWiring()).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('canonical AGENTS.md'),
    });
  });

  it('refreshes canonical guidance while preserving an unmanaged Claude import and notes', () => {
    write(
      'AGENTS.md',
      generateAgentsMd(false).replace(`version=${AGENT_WIRING_VERSION}`, 'version=20'),
    );
    const claude = '@AGENTS.md\n\nKeep these Claude-specific notes.';
    write('CLAUDE.md', claude);
    const results = writeAgentFiles(root, ['claude'], false, false, false, 'patch');
    expect(results.find((item) => item.path === 'CLAUDE.md')?.action).toBe('unchanged');
    expect(read('CLAUDE.md')).toBe(claude);
    expect(read('AGENTS.md')).toBe(generateAgentsMd(false));
    expect(checkAgentWiring().status).toBe('ok');
  });

  it.each([
    'missing',
    'empty',
    'directory',
    'cycle',
    'self-import',
    'unmanaged',
  ] as const)('doctor diagnoses a %s generated import target', (state) => {
    write('CLAUDE.md', generateClaudeMd(false));
    if (state === 'empty') write('AGENTS.md', '');
    if (state === 'directory') mkdirSync(join(root, 'AGENTS.md'));
    if (state === 'cycle') write('AGENTS.md', '@CLAUDE.md\n');
    if (state === 'self-import') write('AGENTS.md', '@AGENTS.md\n');
    if (state === 'unmanaged') write('AGENTS.md', 'App instructions without Plumbus guidance');
    const check = checkAgentWiring();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('AGENTS.md');
  });

  it('doctor diagnoses a disabled import in an otherwise current generated bridge', () => {
    write('AGENTS.md', generateAgentsMd(false));
    write('CLAUDE.md', generateClaudeMd(false).replace('@AGENTS.md', '`@AGENTS.md`'));
    expect(checkAgentWiring()).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('active @AGENTS.md'),
    });
  });

  it('doctor follows the target version even when the Claude bridge is current', () => {
    write('CLAUDE.md', generateClaudeMd(false));
    write(
      'AGENTS.md',
      generateAgentsMd(false).replace(`version=${AGENT_WIRING_VERSION}`, 'version=20'),
    );
    expect(checkAgentWiring()).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('AGENTS.md uses wiring version 20'),
    });
  });
});

describe('agent import detection', () => {
  it.each([
    '@AGENTS.md\n',
    '@./AGENTS.md\n',
    'Shared instructions: @AGENTS.md\n',
  ])('recognizes an active sibling import: %s', (content) =>
    expect(hasAgentFileImport(content, 'AGENTS.md')).toBe(true));
  it.each([
    '`@AGENTS.md`',
    '```text\n@AGENTS.md\n```',
    '~~~~\n@AGENTS.md\n~~~~',
    '<!-- @AGENTS.md -->',
    '    @AGENTS.md',
    '[instructions](AGENTS.md)',
    'Read AGENTS.md',
    '@AGENTS.md.extra',
  ])('ignores examples and non-import references: %s', (content) =>
    expect(hasAgentFileImport(content, 'AGENTS.md')).toBe(false));
});
