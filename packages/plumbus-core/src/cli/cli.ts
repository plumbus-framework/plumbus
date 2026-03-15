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
  registerSeedCommand,
  registerTestCommand,
  registerUiCommand,
  registerVerifyCommand,
} from './commands/index.js';

export function createCli(): Command {
  const program = new Command();

  program
    .name('plumbus')
    .description('Plumbus Framework CLI — AI-native, contract-driven TypeScript applications')
    .version('0.1.0');

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
  registerSeedCommand(program);
  registerUiCommand(program);
  registerDoctorCommand(program);
  registerDevCommand(program);
  registerTestCommand(program);
  registerE2ECommand(program);

  return program;
}
