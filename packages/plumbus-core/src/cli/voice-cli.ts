import { createRequire } from 'node:module';
import { Command } from 'commander';
import { registerVoiceCommand } from './commands/voice.js';
import { assertInsidePlumbusProject } from './utils.js';

/** Worker CLI that does not import unrelated scaffolding or governance commands. */
export function createVoiceCli(): Command {
  const require = createRequire(import.meta.url);
  const { version } = require('../../package.json') as { version: string };
  const program = new Command().name('plumbus').version(version);
  program.hook('preAction', () => {
    assertInsidePlumbusProject();
  });
  registerVoiceCommand(program);
  return program;
}
