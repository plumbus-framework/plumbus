// ── CLI Commands Barrel ──
// All CLI subcommand registration functions.
// Each register*Command(program) adds a subcommand to the Commander program.
//
// Available commands:
//   agent      — Generate AI agent briefs for resources
//   capability — Scaffold a new capability
//   certify    — Run compliance profile assessment
//   create     — Scaffold a new Plumbus application
//   dev        — Start development server with hot reload
//   doctor     — Check environment readiness
//   entity     — Scaffold a new entity
//   event      — Scaffold a new event
//   flow       — Scaffold a new flow
//   generate   — Generate API clients, hooks, OpenAPI specs
//   init       — Generate AI agent wiring files
//   migrate    — Database migration commands
//   prompt     — Scaffold a new prompt
//   rag        — RAG document ingestion
//   verify     — Run governance rules

export { registerAgentCommand } from './agent.js';
export { registerCapabilityCommand } from './capability.js';
export { registerCertifyCommand } from './certify.js';
export { registerCreateCommand } from './create.js';
export { registerDevCommand } from './dev.js';
export { registerDoctorCommand } from './doctor.js';
export { registerEntityCommand } from './entity.js';
export { registerEventCommand } from './event.js';
export { registerFlowCommand } from './flow.js';
export { registerGenerateCommand } from './generate.js';
export { registerInitCommand } from './init.js';
export { registerMigrateCommand } from './migrate.js';
export { registerPromptCommand } from './prompt.js';
export { registerRagCommand } from './rag.js';
export { registerVerifyCommand } from './verify.js';
