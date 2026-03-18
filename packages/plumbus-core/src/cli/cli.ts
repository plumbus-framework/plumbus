// ── CLI Entry Point ──
// Main `plumbus` command with subcommands

import { Command } from 'commander';
import {
    registerAgentCommand,
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
    registerMigrateCommand,
    registerPromptCommand,
    registerRagCommand,
    registerRunCommand,
    registerSeedCommand,
    registerTestCommand,
    registerUiCommand,
    registerVerifyCommand,
} from './commands/index.js';
import { assertInsidePlumbusProject, commandRequiresProject } from './utils.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('plumbus')
    .description('Plumbus Framework CLI — AI-native, contract-driven TypeScript applications')
    .version('0.1.0');

  // Guard: ensure most commands run inside a Plumbus project
  program.hook('preAction', (thisCommand) => {
    // Walk up to the direct child of the program to get the top-level subcommand
    let cmd = thisCommand;
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
  registerMigrateCommand(program);
  registerDbCommand(program);
  registerVerifyCommand(program);
  registerCertifyCommand(program);
  registerAgentCommand(program);
  registerRagCommand(program);
  registerRunCommand(program);
  registerSeedCommand(program);
  registerUiCommand(program);
  registerDoctorCommand(program);
  registerDevCommand(program);
  registerTestCommand(program);
  registerE2ECommand(program);

  return program;
}
