// ── CLI Entry Point ──
// Main `plumbus` command with subcommands

import { createRequire } from 'node:module';
import { Command } from 'commander';
import {
  registerAgentCommand,
  registerBrowserExtensionCommand,
  registerCapabilityCommand,
  registerCertifyCommand,
  registerCreateCommand,
  registerDbCommand,
  registerDevCommand,
  registerDoctorCommand,
  registerE2ECommand,
  registerEntityCommand,
  registerEventCommand,
  registerFlowCommand,
  registerGenerateCommand,
  registerInitCommand,
  registerMcpCommand,
  registerMigrateCommand,
  registerPromptCommand,
  registerRagCommand,
  registerRunCommand,
  registerSeedCommand,
  registerStartCommand,
  registerTestCommand,
  registerTranslationCommand,
  registerUiCommand,
  registerUpgradeCommand,
  registerVerifyCommand,
} from './commands/index.js';
import { assertInsidePlumbusProject, commandRequiresProject } from './utils.js';

function getVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

export function createCli(): Command {
  const program = new Command();

  program
    .name('plumbus')
    .description('Plumbus Framework CLI — AI-native, contract-driven TypeScript applications')
    .version(getVersion());

  // Guard: ensure most commands run inside a Plumbus project
  program.hook('preAction', (_thisCommand, actionCommand) => {
    // Walk up to the direct child of the program to get the top-level subcommand
    let cmd = actionCommand;
    while (cmd.parent?.parent) {
      cmd = cmd.parent;
    }
    if (commandRequiresProject(cmd.name())) {
      assertInsidePlumbusProject();
    }
  });

  registerCreateCommand(program);
  registerInitCommand(program);
  registerCapabilityCommand(program);
  registerFlowCommand(program);
  registerEntityCommand(program);
  registerEventCommand(program);
  registerPromptCommand(program);
  registerGenerateCommand(program);
  registerMcpCommand(program);
  registerMigrateCommand(program);
  registerDbCommand(program);
  registerVerifyCommand(program);
  registerCertifyCommand(program);
  registerAgentCommand(program);
  registerRagCommand(program);
  registerRunCommand(program);
  registerSeedCommand(program);
  registerUiCommand(program);
  registerBrowserExtensionCommand(program);
  registerUpgradeCommand(program);
  registerDoctorCommand(program);
  registerDevCommand(program);
  registerStartCommand(program);
  registerTestCommand(program);
  registerTranslationCommand(program);
  registerE2ECommand(program);

  return program;
}
