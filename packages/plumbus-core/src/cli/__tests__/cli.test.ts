import { describe, expect, it } from 'vitest';
import { createCli } from '../cli.js';

describe('CLI', () => {
  it('creates a program with correct name and version', () => {
    const program = createCli();
    expect(program.name()).toBe('plumbus');
    expect(program.version()).toBe('0.1.0');
  });

  it('registers all expected commands', () => {
    const program = createCli();
    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).toContain('create');
    expect(commandNames).toContain('init');
    expect(commandNames).toContain('capability');
    expect(commandNames).toContain('flow');
    expect(commandNames).toContain('entity');
    expect(commandNames).toContain('event');
    expect(commandNames).toContain('prompt');
    expect(commandNames).toContain('generate');
    expect(commandNames).toContain('migrate');
    expect(commandNames).toContain('verify');
    expect(commandNames).toContain('certify');
    expect(commandNames).toContain('agent');
    expect(commandNames).toContain('rag');
    expect(commandNames).toContain('doctor');
  });
});
