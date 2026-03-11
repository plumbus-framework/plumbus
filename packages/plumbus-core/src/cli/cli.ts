// ── CLI Entry Point ──
// Main `plumbus` command with subcommands

import { Command } from 'commander';
import {
  registerAgentCommand,
  registerCapabilityCommand,
  registerCertifyCommand,
  registerCreateCommand,
  registerDevCommand,
  registerDoctorCommand,
  registerEntityCommand,
  registerEventCommand,
  registerFlowCommand,
  registerGenerateCommand,
  registerInitCommand,
  registerMigrateCommand,
  registerPromptCommand,
  registerRagCommand,
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
  registerVerifyCommand(program);
  registerCertifyCommand(program);
  registerAgentCommand(program);
  registerRagCommand(program);
  registerDoctorCommand(program);
  registerDevCommand(program);

  return program;
}
