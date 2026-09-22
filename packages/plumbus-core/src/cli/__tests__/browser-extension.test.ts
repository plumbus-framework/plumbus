import { describe, expect, it } from 'vitest';
import { createCli } from '../cli.js';

describe('plumbus browser-extension command', () => {
  it('registers browser-extension subcommand with scaffold', () => {
    const program = createCli();
    const be = program.commands.find((c) => c.name() === 'browser-extension');
    expect(be).toBeDefined();
    const scaffold = be?.commands.find((c) => c.name() === 'scaffold');
    expect(scaffold).toBeDefined();
  });
});
