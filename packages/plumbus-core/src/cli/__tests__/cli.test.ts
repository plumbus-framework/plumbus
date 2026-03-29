import { createRequire } from 'node:module';
import type { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { createCli } from '../cli.js';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json') as { version: string };

vi.mock('../utils.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils.js')>();
  return {
    ...original,
    assertInsidePlumbusProject: vi.fn(),
  };
});

/** Reset the mocked assertInsidePlumbusProject and return it. */
async function getMockedAssert() {
  const { assertInsidePlumbusProject } = await import('../utils.js');
  const mockedAssert = vi.mocked(assertInsidePlumbusProject);
  mockedAssert.mockReset();
  return mockedAssert;
}

/** Find a top-level command on the program by name. */
function findCommand(program: Command, name: string) {
  return (program as any).commands.find((c: any) => c.name() === name);
}

/** Find a nested subcommand (e.g. "create" under "db"). */
function findSubcommand(program: Command, parentName: string, childName: string) {
  const parent = findCommand(program, parentName);
  return parent?.commands?.find((c: any) => c.name() === childName);
}

describe('CLI', () => {
  it('creates a program with correct name and version', () => {
    const program = createCli();
    expect(program.name()).toBe('plumbus');
    expect(program.version()).toBe(pkg.version);
  });

  it('registers all expected commands', () => {
    const program = createCli();
    const commandNames = (program as any).commands.map((c: any) => c.name());
    expect(commandNames).toContain('create');
    expect(commandNames).toContain('init');
    expect(commandNames).toContain('capability');
    expect(commandNames).toContain('flow');
    expect(commandNames).toContain('entity');
    expect(commandNames).toContain('event');
    expect(commandNames).toContain('prompt');
    expect(commandNames).toContain('generate');
    expect(commandNames).toContain('migrate');
    expect(commandNames).toContain('db');
    expect(commandNames).toContain('verify');
    expect(commandNames).toContain('certify');
    expect(commandNames).toContain('agent');
    expect(commandNames).toContain('rag');
    expect(commandNames).toContain('ui');
    expect(commandNames).toContain('upgrade');
    expect(commandNames).toContain('doctor');
  });

  describe('preAction project guard', () => {
    it('skips guard for exempt command: create', async () => {
      const mockedAssert = await getMockedAssert();
      const program = createCli();
      findCommand(program, 'create')?.action(() => {});
      program.exitOverride();
      await program.parseAsync(['node', 'plumbus', 'create', 'my-app']);
      expect(mockedAssert).not.toHaveBeenCalled();
    });

    it('skips guard for exempt command: doctor', async () => {
      const mockedAssert = await getMockedAssert();
      const program = createCli();
      findCommand(program, 'doctor')?.action(() => {});
      program.exitOverride();
      await program.parseAsync(['node', 'plumbus', 'doctor']);
      expect(mockedAssert).not.toHaveBeenCalled();
    });

    it('skips guard for exempt command: init', async () => {
      const mockedAssert = await getMockedAssert();
      const program = createCli();
      findCommand(program, 'init')?.action(() => {});
      program.exitOverride();
      await program.parseAsync(['node', 'plumbus', 'init']);
      expect(mockedAssert).not.toHaveBeenCalled();
    });

    it('asserts project for non-exempt command: entity', async () => {
      const mockedAssert = await getMockedAssert();
      const program = createCli();
      findCommand(program, 'entity')?.action(() => {});
      program.exitOverride();
      await program.parseAsync(['node', 'plumbus', 'entity', 'list']);
      expect(mockedAssert).toHaveBeenCalled();
    });

    it('asserts project for non-exempt command: generate', async () => {
      const mockedAssert = await getMockedAssert();
      const program = createCli();
      findCommand(program, 'generate')?.action(() => {});
      program.exitOverride();
      await program.parseAsync(['node', 'plumbus', 'generate']);
      expect(mockedAssert).toHaveBeenCalled();
    });

    it('asserts project for non-exempt command: verify', async () => {
      const mockedAssert = await getMockedAssert();
      const program = createCli();
      findCommand(program, 'verify')?.action(() => {});
      program.exitOverride();
      await program.parseAsync(['node', 'plumbus', 'verify']);
      expect(mockedAssert).toHaveBeenCalled();
    });

    it('resolves top-level command for nested subcommands (translation status)', async () => {
      const mockedAssert = await getMockedAssert();
      const program = createCli();
      findSubcommand(program, 'translation', 'status')?.action(() => {});
      program.exitOverride();
      await program.parseAsync(['node', 'plumbus', 'translation', 'status']);
      expect(mockedAssert).toHaveBeenCalled();
    });

    it('does not confuse nested "create" subcommand with exempt top-level "create" (db create)', async () => {
      const mockedAssert = await getMockedAssert();
      const program = createCli();
      findSubcommand(program, 'db', 'create')?.action(() => {});
      program.exitOverride();
      await program.parseAsync(['node', 'plumbus', 'db', 'create']);
      expect(mockedAssert).toHaveBeenCalled();
    });
  });
});
