// ── CLI Entry Point ──
// Main `plumbus` command with subcommands

import { Command } from 'commander';
import { registerAgentCommand } from './commands/agent.js';
import { registerCapabilityCommand } from './commands/capability.js';
import { registerCertifyCommand } from './commands/certify.js';
import { registerCreateCommand } from './commands/create.js';
import { registerDevCommand } from './commands/dev.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerEntityCommand } from './commands/entity.js';
import { registerEventCommand } from './commands/event.js';
import { registerFlowCommand } from './commands/flow.js';
import { registerGenerateCommand } from './commands/generate.js';
import { registerInitCommand } from './commands/init.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerPromptCommand } from './commands/prompt.js';
import { registerRagCommand } from './commands/rag.js';
import { registerVerifyCommand } from './commands/verify.js';

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
