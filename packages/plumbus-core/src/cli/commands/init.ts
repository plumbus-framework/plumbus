// ── plumbus init ──
// Generate AI agent wiring files that connect coding agents to framework knowledge

import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  detectMonorepoLayout,
  error as logError,
  info,
  success,
  warn,
  writeFile,
} from '../utils.js';

export type AgentFormat = 'copilot' | 'cursor' | 'agents-md';

export interface InitOptions {
  agent?: string;
  inline?: boolean;
  patch?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

type InitWriteMode = 'create' | 'patch' | 'force';
type InitWriteAction = 'created' | 'patched' | 'replaced' | 'skipped' | 'unchanged';

interface AgentFileTarget {
  path: string;
  content: string;
  kind: 'wiring' | 'brief';
}

export interface InitWriteResult {
  path: string;
  action: InitWriteAction;
  message: string;
}

export const AGENT_WIRING_VERSION = 3;
export const AGENT_WIRING_END_MARKER = '<!-- /plumbus:agent-wiring -->';

const AGENT_WIRING_VERSION_PATTERN = /plumbus:agent-wiring version=(\d+)\b/i;
const AGENT_WIRING_START_PATTERN =
  /^(?:<!--\s*plumbus:agent-wiring version=\d+\b.*?-->|#\s*plumbus:agent-wiring version=\d+\b.*)$/m;

function buildAgentWiringStartMarker(
  format: 'copilot' | 'cursor' | 'cursor-capabilities' | 'agents-md',
  inline = false,
  monorepo = false,
  style: 'html' | 'yaml' = 'html',
): string {
  const mode = inline ? 'inline' : 'reference';
  const layout = monorepo ? 'monorepo' : 'flat';
  const marker = `plumbus:agent-wiring version=${AGENT_WIRING_VERSION} format=${format} mode=${mode} layout=${layout}`;
  return style === 'yaml' ? `# ${marker}` : `<!-- ${marker} -->`;
}

export function parseAgentWiringVersion(content: string): number | undefined {
  const match = content.match(AGENT_WIRING_VERSION_PATTERN);
  if (!match) {
    return undefined;
  }
  return Number.parseInt(match[1] ?? '', 10);
}

function getAgentWiringManagedBlockRange(
  content: string,
): { startIndex: number; endIndex: number } | undefined {
  const startMatch = content.match(AGENT_WIRING_START_PATTERN);
  if (!startMatch || startMatch.index === undefined) {
    return undefined;
  }

  const endIndex = content.indexOf(AGENT_WIRING_END_MARKER, startMatch.index);
  if (endIndex === -1) {
    return undefined;
  }

  return {
    startIndex: startMatch.index,
    endIndex: endIndex + AGENT_WIRING_END_MARKER.length,
  };
}

export function hasPatchableAgentWiringBlock(content: string): boolean {
  return getAgentWiringManagedBlockRange(content) !== undefined;
}

function extractAgentWiringManagedBlock(content: string): string | undefined {
  const range = getAgentWiringManagedBlockRange(content);
  if (!range) {
    return undefined;
  }
  return content.slice(range.startIndex, range.endIndex);
}

function patchAgentWiringContent(
  existingContent: string,
  generatedContent: string,
): string | undefined {
  const existingRange = getAgentWiringManagedBlockRange(existingContent);
  const generatedBlock = extractAgentWiringManagedBlock(generatedContent);
  if (!existingRange || !generatedBlock) {
    return undefined;
  }

  return (
    existingContent.slice(0, existingRange.startIndex) +
    generatedBlock +
    existingContent.slice(existingRange.endIndex)
  );
}

const CORE_INSTRUCTION_TOPICS = [
  'guardrails',
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
  'mcp',
] as const;

const GUARDRAIL_LINES = [
  '## Non-Negotiable Guardrails',
  '- Plumbus is the application architecture, not an optional helper library.',
  '- Implement business logic through Plumbus primitives: capabilities, flows, entities, events, prompts, and translations where relevant.',
  '- Do not improvise clean-room architecture such as ad hoc API routes, service layers, jobs, queues, or event buses when Plumbus primitives should own the behavior.',
  '- Use `ctx.data`, `ctx.events`, `ctx.flows`, `ctx.ai`, `ctx.auth`, and other `ctx.*` subsystems instead of bypassing the framework with direct infrastructure code unless the framework explicitly documents that extension point.',
  '- If the correct primitive is unclear, stop and ask which Plumbus extension point should be used.',
  '',
  '## Git Safety',
  '- Allowed without extra approval: read-only inspection such as `git status`, `git diff`, `git log`, `git show`.',
  '- Require explicit user approval before any destructive or history-rewriting command, including `git checkout` used to overwrite files, `git restore`, `git reset`, `git clean`, `git revert` across user work, force-push, and branch or tag deletion.',
  '- Never discard or overwrite existing user work unless the user explicitly asked for that exact action.',
] as const;

function addGuardrailLines(lines: string[]): void {
  lines.push('', ...GUARDRAIL_LINES);
}

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
    buildAgentWiringStartMarker('copilot', inline, monorepo),
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

  addGuardrailLines(lines);

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

  lines.push('', AGENT_WIRING_END_MARKER);
  lines.push('');

  return lines.join('\n');
}

/** Generate the Cursor .mdc rule content */
export function generateCursorRule(inline: boolean, monorepo = false): string {
  const appPrefix = monorepo ? 'backend/' : '';
  const lines = [
    '---',
    buildAgentWiringStartMarker('cursor', inline, monorepo, 'yaml'),
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
  ];

  addGuardrailLines(lines);

  lines.push('', '## SDK Reference');

  addInstructionReferenceLines(lines, inline);

  addDocumentationMaintenanceLines(lines);

  lines.push('', AGENT_WIRING_END_MARKER);
  lines.push('');
  return lines.join('\n');
}

/** Generate capability-specific Cursor rule */
export function generateCursorCapabilityRule(): string {
  return `---
${buildAgentWiringStartMarker('cursor-capabilities', false, false, 'yaml')}
description: Plumbus capability development rules
globs: app/capabilities/**
---

When creating or modifying capabilities:
- Capability code is the primary home for business logic in Plumbus.
- Use \`defineCapability()\` from @plumbus/core
- Always declare effects (data, events, external, ai)
- Set access policies (deny-by-default)
- Use \`ctx.data\`, \`ctx.events\`, \`ctx.ai\` within handlers
- To expose a capability to AI agents over MCP, add \`exposeAs: ["mcp"]\` and optional \`mcp: { description, dangerous, agentTags }\`. Only \`query\` and \`action\` kinds are eligible.
- If the task appears to need a custom service, controller, route, or worker, stop and ask which Plumbus primitive should own it instead.
- Never run destructive git commands such as file-overwriting \`git checkout\`, \`git restore\`, \`git reset\`, or \`git clean\` without explicit user approval.
- Reference: \`node_modules/@plumbus/core/instructions/capabilities.md\` and \`node_modules/@plumbus/core/instructions/mcp.md\`
${AGENT_WIRING_END_MARKER}
`;
}

/** Generate AGENTS.md content */
export function generateAgentsMd(inline: boolean, monorepo = false): string {
  const appPrefix = monorepo ? 'backend/' : '';
  const lines = [
    buildAgentWiringStartMarker('agents-md', inline, monorepo),
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

  addGuardrailLines(lines);

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

  lines.push('', AGENT_WIRING_END_MARKER);
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
function buildAgentFileTargets(
  projectRoot: string,
  formats: AgentFormat[],
  inline: boolean,
  includeProjectBrief = true,
  monorepo = false,
): AgentFileTarget[] {
  const targets: AgentFileTarget[] = [];

  for (const format of formats) {
    switch (format) {
      case 'copilot': {
        targets.push({
          path: path.join(projectRoot, '.github', 'copilot-instructions.md'),
          content: generateCopilotInstructions(inline, monorepo),
          kind: 'wiring',
        });
        break;
      }
      case 'cursor': {
        targets.push({
          path: path.join(projectRoot, '.cursor', 'rules', 'plumbus.mdc'),
          content: generateCursorRule(inline, monorepo),
          kind: 'wiring',
        });
        targets.push({
          path: path.join(projectRoot, '.cursor', 'rules', 'plumbus-capabilities.mdc'),
          content: generateCursorCapabilityRule(),
          kind: 'wiring',
        });
        break;
      }
      case 'agents-md': {
        targets.push({
          path: path.join(projectRoot, 'AGENTS.md'),
          content: generateAgentsMd(inline, monorepo),
          kind: 'wiring',
        });
        break;
      }
    }
  }

  if (includeProjectBrief) {
    targets.push({
      path: path.join(projectRoot, '.plumbus', 'briefs', 'project.md'),
      content: generateProjectBrief(),
      kind: 'brief',
    });
  }

  return targets;
}

function relativeTargetPath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, '/');
}

function writeTargetContent(filePath: string, content: string, dryRun: boolean): void {
  if (!dryRun) {
    writeFile(filePath, content);
  }
}

export function writeAgentFiles(
  projectRoot: string,
  formats: AgentFormat[],
  inline: boolean,
  includeProjectBrief = true,
  monorepo = false,
  mode: InitWriteMode = 'create',
  dryRun = false,
): InitWriteResult[] {
  const results: InitWriteResult[] = [];
  const targets = buildAgentFileTargets(
    projectRoot,
    formats,
    inline,
    includeProjectBrief,
    monorepo,
  );

  for (const target of targets) {
    const relPath = relativeTargetPath(projectRoot, target.path);
    if (!fs.existsSync(target.path)) {
      writeTargetContent(target.path, target.content, dryRun);
      results.push({
        path: relPath,
        action: 'created',
        message: `${dryRun ? 'Would create' : 'Created'} ${relPath}`,
      });
      continue;
    }

    const existingContent = fs.readFileSync(target.path, 'utf-8');

    if (target.kind === 'brief') {
      results.push({
        path: relPath,
        action: 'skipped',
        message: `Skipped ${relPath}: existing project brief preserved. Run \`plumbus agent sync\` to refresh it.`,
      });
      continue;
    }

    if (mode === 'create') {
      results.push({
        path: relPath,
        action: 'skipped',
        message: `Skipped ${relPath}: file already exists. Use \`plumbus init --patch\` to update managed sections or \`plumbus init --force\` to replace it.`,
      });
      continue;
    }

    if (mode === 'patch') {
      const patchedContent = patchAgentWiringContent(existingContent, target.content);
      if (!patchedContent) {
        results.push({
          path: relPath,
          action: 'skipped',
          message: `Skipped ${relPath}: no Plumbus-managed block found. Use \`plumbus init --force\` to replace it.`,
        });
        continue;
      }

      if (patchedContent === existingContent) {
        results.push({
          path: relPath,
          action: 'unchanged',
          message: `${relPath} is already up to date.`,
        });
        continue;
      }

      writeTargetContent(target.path, patchedContent, dryRun);
      results.push({
        path: relPath,
        action: 'patched',
        message: `${dryRun ? 'Would patch' : 'Patched'} ${relPath}`,
      });
      continue;
    }

    if (existingContent === target.content) {
      results.push({
        path: relPath,
        action: 'unchanged',
        message: `${relPath} is already up to date.`,
      });
      continue;
    }

    writeTargetContent(target.path, target.content, dryRun);
    results.push({
      path: relPath,
      action: 'replaced',
      message: `${dryRun ? 'Would replace' : 'Replaced'} ${relPath}`,
    });
  }

  return results;
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
    .option('--patch', 'Update only Plumbus-managed sections and create missing files')
    .option('--force', 'Replace existing generated wiring files outright')
    .option('--dry-run', 'Show what would change without writing files')
    .action((opts: InitOptions) => {
      if (opts.patch && opts.force) {
        logError('Choose either --patch or --force, not both.');
        process.exit(1);
      }

      const projectRoot = process.cwd();
      const formats = parseAgentFormats(opts.agent);
      const monorepo = detectMonorepoLayout(projectRoot);
      const mode: InitWriteMode = opts.force ? 'force' : opts.patch ? 'patch' : 'create';
      const results = writeAgentFiles(
        projectRoot,
        formats,
        opts.inline ?? false,
        true,
        monorepo.isMonorepo,
        mode,
        opts.dryRun ?? false,
      );

      for (const result of results) {
        switch (result.action) {
          case 'created':
          case 'patched':
          case 'replaced':
            if (opts.dryRun) {
              info(result.message);
            } else {
              success(result.message);
            }
            break;
          case 'unchanged':
            info(result.message);
            break;
          case 'skipped':
            warn(result.message);
            break;
        }
      }

      info(
        opts.dryRun
          ? 'Dry run complete. Run `plumbus agent sync` separately if you want to refresh the project brief.'
          : 'Agent wiring complete. Run `plumbus agent sync` to populate or refresh the project brief.',
      );
    });
}
