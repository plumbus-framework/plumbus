// ── plumbus init ──
// Generate AI agent wiring files that connect coding agents to framework knowledge

import type { Command } from 'commander';
import * as path from 'node:path';
import { detectMonorepoLayout, info, success, writeFile } from '../utils.js';

export type AgentFormat = 'copilot' | 'cursor' | 'agents-md';

export interface InitOptions {
  agent?: string;
  inline?: boolean;
}

const CORE_INSTRUCTION_TOPICS = [
  'framework',
  'cli',
  'capabilities',
  'flows',
  'entities',
  'events',
  'ai',
  'security',
  'governance',
  'testing',
  'patterns',
] as const;

const UI_INSTRUCTION_REFERENCES = [
  {
    area: 'frontend/ui generation',
    path: 'node_modules/@plumbus/ui/instructions/framework.md',
  },
  {
    area: 'typed clients and hooks',
    path: 'node_modules/@plumbus/ui/instructions/client-generator.md',
  },
  {
    area: 'auth helpers',
    path: 'node_modules/@plumbus/ui/instructions/auth-generator.md',
  },
  {
    area: 'form metadata generation',
    path: 'node_modules/@plumbus/ui/instructions/form-generator.md',
  },
  {
    area: 'Next.js frontend scaffolding',
    path: 'node_modules/@plumbus/ui/instructions/nextjs-template.md',
  },
  {
    area: 'frontend test coverage',
    path: 'node_modules/@plumbus/ui/instructions/testing.md',
  },
  {
    area: 'frontend generation patterns',
    path: 'node_modules/@plumbus/ui/instructions/patterns.md',
  },
] as const;

function addInstructionReferenceLines(lines: string[], inline: boolean): void {
  if (inline) {
    lines.push(
      'Refer to the bundled framework and UI instruction files in this project for full SDK documentation.',
    );
    return;
  }

  for (const topic of CORE_INSTRUCTION_TOPICS) {
    lines.push(
      `- When working on ${topic}, read \`node_modules/@plumbus/core/instructions/${topic}.md\``,
    );
  }

  for (const reference of UI_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }
}

/** Documentation maintenance section shared across all agent file formats */
function addDocumentationMaintenanceLines(lines: string[]): void {
  lines.push(
    '',
    '## Documentation Maintenance — CRITICAL',
    '',
    '**Every code change must include corresponding documentation updates.** The project has comprehensive documentation in `docs/`. Read `docs/maintaining-docs.md` for the full area-to-doc mapping.',
    '',
    '### Area-to-Doc Quick Reference',
    '',
    '| Code Area | Update These Docs |',
    '|-----------|------------------|',
    '| `app/entities/` | `docs/architecture/data-model.md` |',
    '| `app/capabilities/` | `docs/capabilities/index.md` |',
    '| `app/flows/` | `docs/flows/index.md` |',
    '| `app/events/` | `docs/events/index.md` |',
    '| `app/prompts/` | `docs/prompts/index.md` |',
    '| `config/` | `docs/configuration/index.md` |',
    '| `frontend/` | `docs/frontend/architecture.md` |',
    '| `frontend-admin/` | `docs/frontend/architecture.md`, `docs/admin/operations.md` |',
    '| New domain concept | Create or update `docs/domain/` |',
    '| Architecture change | Update `docs/architecture/` |',
    '',
    '### Documentation Rules',
    '',
    '1. **Accuracy over speed** — docs must match actual code',
    '2. **ASCII diagrams only** — do NOT use Mermaid (too fragile with AI edits)',
    '3. **Cross-references** — always link to related docs',
    '4. **No stale content** — if you remove code, remove its docs',
    '5. **Full docs index** — `docs/README.md` is the table of contents',
  );
}

/** Framework-provided dependency warnings shared across agent file formats */
function addFrameworkDependencyLines(lines: string[]): void {
  lines.push(
    '',
    '## Framework-Provided Dependencies — DO NOT Install Separately',
    '',
    "The framework provides these packages. **Never add them to this project's package.json**:",
    '',
    '### From `@plumbus/core`',
    '',
    '| Package | Import from | NOT from |',
    '|---------|-------------|----------|',
    '| zod | `@plumbus/core/zod` | ~~`zod`~~ |',
    '| vitest | `vitest` (at runtime) | ~~devDependencies~~ |',
    '| vitest config | `@plumbus/core/vitest` | ~~`vitest/config`~~ |',
    '| playwright | `@plumbus/core/testing` | ~~`playwright`~~ |',
    '',
    '### From `@plumbus/ui`',
    '',
    '| Package | NOT in package.json |',
    '|---------|--------------------|',
    '| next | ~~`next`~~ |',
    '| react | ~~`react`~~ |',
    '| react-dom | ~~`react-dom`~~ |',
    '| tailwindcss | ~~`tailwindcss`~~ |',
    '| @tailwindcss/postcss | ~~`@tailwindcss/postcss`~~ |',
    '| typescript | ~~`typescript`~~ |',
    '| @types/react | ~~`@types/react`~~ |',
    '| @types/react-dom | ~~`@types/react-dom`~~ |',
  );
}

/** Generate the copilot-instructions.md content */
export function generateCopilotInstructions(inline: boolean, monorepo = false): string {
  const appPrefix = monorepo ? 'backend/' : '';
  const lines = [
    '# Plumbus Framework — Copilot Instructions',
    '',
    'This project is built with the Plumbus framework — an AI-native, contract-driven TypeScript framework.',
    '',
    '## Key Conventions',
    `- Business logic lives in \`${appPrefix}app/capabilities/<domain>/<name>/\``,
    `- Data models in \`${appPrefix}app/entities/\``,
    `- Workflows in \`${appPrefix}app/flows/<domain>/<name>/\``,
    `- Events in \`${appPrefix}app/events/\``,
    `- AI prompts in \`${appPrefix}app/prompts/\``,
    `- Config in \`${appPrefix}config/\``,
    ...(monorepo ? ['- Frontend in `frontend/`', '- Shared types in `libs/shared/types/`'] : []),
    '',
    '## Edit Zones',
    `- **Safe**: \`${appPrefix}app/\` directory (capabilities, entities, flows, events, prompts), \`${appPrefix}config/\`, \`docs/\`, tests${monorepo ? ', `frontend/`, `libs/shared/`' : ''}`,
    '- **Restricted**: `.plumbus/` generated files (regenerated by CLI)',
    '- **Forbidden**: `node_modules/`, `dist/`',
  ];

  addFrameworkDependencyLines(lines);

  lines.push(
    '',
    '### Commands',
    '| Task | Command |',
    '|------|---------|',
    '| Run tests | `plumbus test` |',
    '| Watch tests | `plumbus test --watch` |',
    '| Run e2e | `plumbus test --config frontend/e2e/vitest.config.e2e.ts` |',
    '| Dev server | `plumbus dev` |',
    '',
    '## CLI Scaffolding',
    '**Always run CLI commands from the project root**. Use the Plumbus CLI to scaffold new primitives and UI artifacts:',
    '```',
    'plumbus entity new <EntityName>',
    'plumbus capability new <CapabilityName>',
    'plumbus event new <EventName>',
    'plumbus flow new <FlowName>',
    'plumbus prompt new <PromptName>',
    'plumbus ui generate',
    'plumbus ui nextjs <output-dir>',
    '```',
    'After scaffolding, fill in the `// TODO` sections in the generated files.',
    '',
    '## SDK Reference',
  );

  addInstructionReferenceLines(lines, inline);

  lines.push(
    '',
    '## Project Brief',
    'See `.plumbus/briefs/project.md` for project-specific context.',
  );

  addDocumentationMaintenanceLines(lines);

  lines.push('');

  return lines.join('\n');
}

/** Generate the Cursor .mdc rule content */
export function generateCursorRule(inline: boolean, monorepo = false): string {
  const appPrefix = monorepo ? 'backend/' : '';
  const lines = [
    '---',
    `description: Plumbus framework conventions and SDK reference`,
    `globs: ${appPrefix}app/**`,
    '---',
    '',
    '# Plumbus Framework',
    '',
    'This project uses the Plumbus framework for building AI-native, contract-driven applications.',
    '',
    '## Conventions',
    `- Capabilities: \`${appPrefix}app/capabilities/<domain>/<name>/\``,
    `- Entities: \`${appPrefix}app/entities/<name>.entity.ts\``,
    `- Flows: \`${appPrefix}app/flows/<domain>/<name>/\``,
    `- Events: \`${appPrefix}app/events/<name>.event.ts\``,
    `- Prompts: \`${appPrefix}app/prompts/<name>.prompt.ts\``,
    '',
    '## Edit Zones',
    `- Safe: \`${appPrefix}app/\`, \`${appPrefix}config/\`, \`docs/\`, tests${monorepo ? ', `frontend/`, `libs/shared/`' : ''}`,
    '- Restricted: `.plumbus/generated/`',
    '- Forbidden: `node_modules/`, `dist/`',
    '',
    '## SDK Reference',
  ];

  addInstructionReferenceLines(lines, inline);

  addDocumentationMaintenanceLines(lines);

  lines.push('');
  return lines.join('\n');
}

/** Generate capability-specific Cursor rule */
export function generateCursorCapabilityRule(): string {
  return `---
description: Plumbus capability development rules
globs: app/capabilities/**
---

When creating or modifying capabilities:
- Use \`defineCapability()\` from @plumbus/core
- Always declare effects (data, events, external, ai)
- Set access policies (deny-by-default)
- Use \`ctx.data\`, \`ctx.events\`, \`ctx.ai\` within handlers
- Reference: \`node_modules/@plumbus/core/instructions/capabilities.md\`
`;
}

/** Generate AGENTS.md content */
export function generateAgentsMd(inline: boolean, monorepo = false): string {
  const appPrefix = monorepo ? 'backend/' : '';
  const lines = [
    '# AGENTS.md — Plumbus Framework',
    '',
    'This project is built with the Plumbus framework.',
    '',
    '## Architecture',
    'AI-native, contract-driven TypeScript framework with primitives:',
    'Entities, Capabilities, Flows, Events, Prompts — composed through `ctx`.',
    '',
    '## Directory Structure',
    `- \`${appPrefix}app/capabilities/<domain>/<name>/\` — Business logic`,
    `- \`${appPrefix}app/entities/\` — Data models`,
    `- \`${appPrefix}app/flows/<domain>/<name>/\` — Multi-step workflows`,
    `- \`${appPrefix}app/events/\` — Domain events`,
    `- \`${appPrefix}app/prompts/\` — AI prompt definitions`,
    `- \`${appPrefix}config/\` — App + AI configuration`,
    ...(monorepo
      ? ['- `frontend/` — Next.js frontend', '- `libs/shared/types/` — Shared type definitions']
      : []),
    '- `.plumbus/generated/` — Auto-generated (do not edit)',
    '',
    '## Edit Zones',
    `- **Safe**: \`${appPrefix}app/\`, \`${appPrefix}config/\`, \`docs/\`, tests${monorepo ? ', `frontend/`, `libs/shared/`' : ''}`,
    '- **Restricted**: `.plumbus/` (regenerated by `plumbus generate`)',
    '- **Forbidden**: `node_modules/`, `dist/`',
  ];

  addFrameworkDependencyLines(lines);

  lines.push(
    '',
    '### Commands',
    '| Task | Command |',
    '|------|---------|',
    '| Run tests | `plumbus test` |',
    '| Watch tests | `plumbus test --watch` |',
    '| Run e2e | `plumbus test --config frontend/e2e/vitest.config.e2e.ts` |',
    '| Dev server | `plumbus dev` |',
    '',
    '## SDK Reference',
  );

  addInstructionReferenceLines(lines, inline);

  addDocumentationMaintenanceLines(lines);

  lines.push('');
  return lines.join('\n');
}

/** Generate the project brief */
export function generateProjectBrief(): string {
  return `# Project Brief

> Auto-generated by \`plumbus init\`. Update with \`plumbus agent sync\`.

## Registered Resources

- **Entities**: (run \`plumbus agent sync\` to populate)
- **Capabilities**: (run \`plumbus agent sync\` to populate)
- **Flows**: (run \`plumbus agent sync\` to populate)
- **Events**: (run \`plumbus agent sync\` to populate)
- **Prompts**: (run \`plumbus agent sync\` to populate)

## Configuration

- **Auth**: (detected at sync)
- **AI**: (detected at sync)
- **Compliance**: (detected at sync)

## Governance Warnings

None detected. Run \`plumbus verify\` to check.
`;
}

/** Write all files for a given agent format */
export function writeAgentFiles(
  projectRoot: string,
  formats: AgentFormat[],
  inline: boolean,
  includeProjectBrief = true,
  monorepo = false,
): string[] {
  const written: string[] = [];

  for (const format of formats) {
    switch (format) {
      case 'copilot': {
        const filePath = path.join(projectRoot, '.github', 'copilot-instructions.md');
        writeFile(filePath, generateCopilotInstructions(inline, monorepo));
        written.push('.github/copilot-instructions.md');
        break;
      }
      case 'cursor': {
        const mainRule = path.join(projectRoot, '.cursor', 'rules', 'plumbus.mdc');
        writeFile(mainRule, generateCursorRule(inline, monorepo));
        written.push('.cursor/rules/plumbus.mdc');

        const capRule = path.join(projectRoot, '.cursor', 'rules', 'plumbus-capabilities.mdc');
        writeFile(capRule, generateCursorCapabilityRule());
        written.push('.cursor/rules/plumbus-capabilities.mdc');
        break;
      }
      case 'agents-md': {
        const filePath = path.join(projectRoot, 'AGENTS.md');
        writeFile(filePath, generateAgentsMd(inline, monorepo));
        written.push('AGENTS.md');
        break;
      }
    }
  }

  if (includeProjectBrief) {
    const briefPath = path.join(projectRoot, '.plumbus', 'briefs', 'project.md');
    writeFile(briefPath, generateProjectBrief());
    written.push('.plumbus/briefs/project.md');
  }

  return written;
}

function parseAgentFormats(agent?: string): AgentFormat[] {
  if (!agent || agent === 'all') {
    return ['copilot', 'cursor', 'agents-md'];
  }
  const valid: AgentFormat[] = ['copilot', 'cursor', 'agents-md'];
  if (valid.includes(agent as AgentFormat)) {
    return [agent as AgentFormat];
  }
  return ['copilot', 'cursor', 'agents-md'];
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Generate AI agent wiring files for the project')
    .option('--agent <format>', 'Agent format: copilot, cursor, all (default: all)')
    .option('--inline', 'Copy full instruction content instead of referencing node_modules')
    .action((opts: InitOptions) => {
      const projectRoot = process.cwd();
      const formats = parseAgentFormats(opts.agent);
      const monorepo = detectMonorepoLayout(projectRoot);
      const written = writeAgentFiles(
        projectRoot,
        formats,
        opts.inline ?? false,
        true,
        monorepo.isMonorepo,
      );

      for (const f of written) {
        success(`Created ${f}`);
      }

      info('Agent wiring complete. Run `plumbus agent sync` to populate project brief.');
    });
}
