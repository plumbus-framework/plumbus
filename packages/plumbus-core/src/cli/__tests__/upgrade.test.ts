import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerUpgradeCommand } from '../commands/upgrade.js';

describe('plumbus upgrade', () => {
  it('registers the upgrade command on a Commander program', () => {
    const program = new Command();
    registerUpgradeCommand(program);
    const cmd = (program as any).commands.find((c: any) => c.name() === 'upgrade');
    expect(cmd).toBeDefined();
    expect(cmd.description()).toContain('Migrate legacy artifacts');
  });

  it('has a --dry-run option', () => {
    const program = new Command();
    registerUpgradeCommand(program);
    const cmd = (program as any).commands.find((c: any) => c.name() === 'upgrade');
    const opts = cmd.options.map((o: any) => o.long);
    expect(opts).toContain('--dry-run');
  });
});
