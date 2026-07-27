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

export const AGENT_WIRING_VERSION = 11;
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
  'api',
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

const CHAT_INSTRUCTION_REFERENCES = [
  {
    area: 'chat framework overview, package conventions, and critical rules',
    path: 'node_modules/@plumbus/chat/instructions/framework.md',
  },
  {
    area: 'adding a new chat with defineChat (recipe + full config shape), including enabling provider-native tool calling (policy.toolCalling, Path B)',
    path: 'node_modules/@plumbus/chat/instructions/defining-chats.md',
  },
  {
    area: 'configuring chat policy guards (audience, scope, behavioral, action, etc.), tool calling (policy.toolCalling, Path B)',
    path: 'node_modules/@plumbus/chat/instructions/policies.md',
  },
  {
    area: 'wiring chat context sources (knowledgeContext, capabilityContext, staticContext)',
    path: 'node_modules/@plumbus/chat/instructions/context-sources.md',
  },
  {
    area: 'testing chats with mockChatRuntime and pure UI helpers',
    path: 'node_modules/@plumbus/chat/instructions/testing.md',
  },
  {
    area: 'extending chat with custom prompts, context sources, or guards',
    path: 'node_modules/@plumbus/chat/instructions/extending.md',
  },
  {
    area: 'chat instruction index and reading order',
    path: 'node_modules/@plumbus/chat/instructions/README.md',
  },
] as const;

const KNOWLEDGE_BASE_INSTRUCTION_REFERENCES = [
  {
    area: 'knowledge-base conventions, file map, and critical rules',
    path: 'node_modules/@plumbus/knowledge-base/instructions/conventions.md',
  },
  {
    area: 'defining knowledge sources and createKnowledgeRegistry',
    path: 'node_modules/@plumbus/knowledge-base/instructions/defining-sources.md',
  },
  {
    area: 'choosing KB providers (staticBlocks, ragCorpus, translationCatalog, etc.)',
    path: 'node_modules/@plumbus/knowledge-base/instructions/providers.md',
  },
  {
    area: 'wiring registry-backed knowledgeContext in chat',
    path: 'node_modules/@plumbus/knowledge-base/instructions/chat-integration.md',
  },
  {
    area: 'testing knowledge sources and registries',
    path: 'node_modules/@plumbus/knowledge-base/instructions/testing.md',
  },
  {
    area: 'knowledge-base instruction index and reading order',
    path: 'node_modules/@plumbus/knowledge-base/instructions/README.md',
  },
] as const;

const CHAT_UI_INSTRUCTION_REFERENCES = [
  {
    area: 'chat-ui package boundary (React-only), public exports, file map, critical rules',
    path: 'node_modules/@plumbus/chat-ui/instructions/framework.md',
  },
  {
    area: 'wiring <ChatPanel /> — sessionId, persistence pairing with the server, turnUrl override',
    path: 'node_modules/@plumbus/chat-ui/instructions/wiring-chat-panel.md',
  },
  {
    area: 'custom chat UIs — headless useChat, the pure helpers, readChatStream',
    path: 'node_modules/@plumbus/chat-ui/instructions/custom-ui.md',
  },
  {
    area: 'action confirmation — useChat.confirm()/decline() drive the real POST /chat/:name/confirm round-trip and Path B tool confirmation',
    path: 'node_modules/@plumbus/chat-ui/instructions/action-confirmation.md',
  },
  {
    area: 'chat-ui instruction index and reading order',
    path: 'node_modules/@plumbus/chat-ui/instructions/README.md',
  },
] as const;

const VOICE_INSTRUCTION_REFERENCES = [
  {
    area: 'voice runtime overview, package boundary, file map, and critical rules',
    path: 'node_modules/@plumbus/voice/instructions/framework.md',
  },
  {
    area: 'wiring client-side STT with web-speech and transcript relay',
    path: 'node_modules/@plumbus/voice/instructions/client-stt.md',
  },
  {
    area: 'choosing local or self-hosted voice providers',
    path: 'node_modules/@plumbus/voice/instructions/local-providers.md',
  },
  {
    area: 'adding a new voice with defineVoice and registerVoiceRoutes',
    path: 'node_modules/@plumbus/voice/instructions/defining-voices.md',
  },
  {
    area: 'picking STT, TTS, and transport providers for a voice surface',
    path: 'node_modules/@plumbus/voice/instructions/providers.md',
  },
  {
    area: 'tagging voice STT, TTS, and transport spend in the shared AI ledger',
    path: 'node_modules/@plumbus/voice/instructions/cost-tracking.md',
  },
  {
    area: 'testing voice routes, websocket handshakes, and mock runtimes',
    path: 'node_modules/@plumbus/voice/instructions/testing.md',
  },
  {
    area: 'securing voice session routes, tokens, catalog endpoints, and client STT trust boundaries',
    path: 'node_modules/@plumbus/voice/instructions/security.md',
  },
  {
    area: 'extending voice with custom providers, hooks, and runtime adapters',
    path: 'node_modules/@plumbus/voice/instructions/extending.md',
  },
  {
    area: 'configuring noise cancellation options on room transports',
    path: 'node_modules/@plumbus/voice/instructions/noise-cancellation.md',
  },
  {
    area: 'voice instruction index and reading order',
    path: 'node_modules/@plumbus/voice/instructions/README.md',
  },
] as const;

const VOICE_DEEPDUB_INSTRUCTION_REFERENCES = [
  {
    area: 'voice-deepdub instruction index and reading order',
    path: 'node_modules/@plumbus/voice-deepdub/instructions/README.md',
  },
  {
    area: 'Deepdub TTS provider add-on for @plumbus/voice (tts.provider: deepdub)',
    path: 'node_modules/@plumbus/voice-deepdub/instructions/framework.md',
  },
] as const;

const VOICE_SONIOX_INSTRUCTION_REFERENCES = [
  {
    area: 'voice-soniox instruction index and reading order',
    path: 'node_modules/@plumbus/voice-soniox/instructions/README.md',
  },
  {
    area: 'Soniox STT provider add-on for @plumbus/voice (stt.provider: soniox)',
    path: 'node_modules/@plumbus/voice-soniox/instructions/framework.md',
  },
] as const;

const VOICE_ELEVENLABS_INSTRUCTION_REFERENCES = [
  {
    area: 'voice-elevenlabs instruction index and reading order',
    path: 'node_modules/@plumbus/voice-elevenlabs/instructions/README.md',
  },
  {
    area: 'ElevenLabs TTS provider add-on for @plumbus/voice (tts.provider: elevenlabs)',
    path: 'node_modules/@plumbus/voice-elevenlabs/instructions/framework.md',
  },
] as const;

const VOICE_MINIMAX_INSTRUCTION_REFERENCES = [
  {
    area: 'voice-minimax instruction index and reading order',
    path: 'node_modules/@plumbus/voice-minimax/instructions/README.md',
  },
  {
    area: 'MiniMax TTS provider add-on for @plumbus/voice (tts.provider: minimax)',
    path: 'node_modules/@plumbus/voice-minimax/instructions/framework.md',
  },
] as const;

const VOICE_LIVEKIT_INSTRUCTION_REFERENCES = [
  {
    area: 'voice-livekit instruction index and reading order',
    path: 'node_modules/@plumbus/voice-livekit/instructions/README.md',
  },
  {
    area: 'LiveKit transport install, peers, registration, env, and exports',
    path: 'node_modules/@plumbus/voice-livekit/instructions/framework.md',
  },
  {
    area: 'LiveKit browser session (createLiveKitVoiceSession from ./client)',
    path: 'node_modules/@plumbus/voice-livekit/instructions/client-session.md',
  },
  {
    area: 'LiveKit agent worker and plumbus voice worker',
    path: 'node_modules/@plumbus/voice-livekit/instructions/agent-worker.md',
  },
  {
    area: 'LiveKit noise cancellation (client/agent placement and engines)',
    path: 'node_modules/@plumbus/voice-livekit/instructions/noise-cancellation.md',
  },
] as const;

const VOICE_OPENAI_INSTRUCTION_REFERENCES = [
  {
    area: 'voice-openai instruction index and reading order',
    path: 'node_modules/@plumbus/voice-openai/instructions/README.md',
  },
  {
    area: 'OpenAI STT/TTS provider add-on for @plumbus/voice (openai-whisper / openai-realtime / openai)',
    path: 'node_modules/@plumbus/voice-openai/instructions/framework.md',
  },
] as const;

const MCP_INSTRUCTION_REFERENCES = [
  {
    area: 'MCP runtime overview, package boundary (core vs @plumbus/mcp), public exports, critical rules',
    path: 'node_modules/@plumbus/mcp/instructions/framework.md',
  },
  {
    area: 'exposing a capability as an MCP tool (exposeAs:[mcp], mcp.agents config, plumbus mcp serve)',
    path: 'node_modules/@plumbus/mcp/instructions/expose-a-capability.md',
  },
  {
    area: "long-running kind:'job' capabilities via MCP Tasks (mcpTaskEntity wiring, ctx.progress, cancellation)",
    path: 'node_modules/@plumbus/mcp/instructions/tasks.md',
  },
  {
    area: 'testing MCP capabilities with createTestMcpServer and mockMcpClient',
    path: 'node_modules/@plumbus/mcp/instructions/testing.md',
  },
  {
    area: 'MCP instruction index and reading order',
    path: 'node_modules/@plumbus/mcp/instructions/README.md',
  },
] as const;

const API_INSTRUCTION_REFERENCES = [
  {
    area: 'partner API runtime overview, package boundary (core vs @plumbus/api), public exports, critical rules',
    path: 'node_modules/@plumbus/api/instructions/framework.md',
  },
  {
    area: "exposing a capability as a partner API route (exposeAs:['api'], api metadata, registerApiRoutes)",
    path: 'node_modules/@plumbus/api/instructions/expose-a-capability.md',
  },
  {
    area: 'api.yaml manifest, validation, OpenAPI/docs generation, compatibility diff, plumbus api CLI',
    path: 'node_modules/@plumbus/api/instructions/manifest-and-cli.md',
  },
  {
    area: 'testing partner API routes with test intent, idempotency, and fixture validation',
    path: 'node_modules/@plumbus/api/instructions/testing.md',
  },
  {
    area: 'partner API instruction index and reading order',
    path: 'node_modules/@plumbus/api/instructions/README.md',
  },
] as const;

const BROWSER_EXTENSION_INSTRUCTION_REFERENCES = [
  {
    area: 'scaffolding a WXT Chrome/Firefox browser extension wired to capabilities (plumbus browser-extension scaffold; app-owned /api/auth/* + CORS; bearer token in browser.storage.local; explicit background capability registry)',
    path: 'node_modules/@plumbus/browser-extension/instructions/browser-extension.md',
  },
] as const;

const AUTH_INSTRUCTION_REFERENCES = [
  {
    area: 'OIDC auth runtime overview, package boundary, public exports, and critical rules',
    path: 'node_modules/@plumbus/auth/instructions/framework.md',
  },
  {
    area:
      'wiring createAuthRuntime, stores, resolvers, optional loginContext, and ' +
      'createServer({ authenticationRuntime })',
    path: 'node_modules/@plumbus/auth/instructions/configure-runtime.md',
  },
  {
    area: 'registering OIDC providers, discovery, integrations, and provider logout',
    path: 'node_modules/@plumbus/auth/instructions/providers.md',
  },
  {
    area: 'opaque session cookies, CSRF, same-site deployment, and /auth/session contract',
    path: 'node_modules/@plumbus/auth/instructions/sessions-and-csrf.md',
  },
  {
    area:
      'resolveIdentity and resolveAuthorization hooks (admit/deny and roles/scopes/tenant), and ' +
      'invitation-only admission via loginContext when login must carry app context (invite, account link) ' +
      'that resolveIdentity needs but no user session exists yet',
    path: 'node_modules/@plumbus/auth/instructions/resolvers.md',
  },
  {
    area: 'testing OIDC login with @plumbus/auth/testing fake provider and integration patterns',
    path: 'node_modules/@plumbus/auth/instructions/testing.md',
  },
  {
    area: 'auth instruction index and reading order',
    path: 'node_modules/@plumbus/auth/instructions/README.md',
  },
] as const;

const AUTH_COGNITO_INSTRUCTION_REFERENCES = [
  {
    area: 'Cognito integration package boundary and critical rules',
    path: 'node_modules/@plumbus/auth-cognito/instructions/framework.md',
  },
  {
    area: 'registering a Cognito OIDC provider with cognito() integration on @plumbus/auth',
    path: 'node_modules/@plumbus/auth-cognito/instructions/configure-cognito.md',
  },
  {
    area: 'Cognito hosted UI identity_provider allowlist and default IdP options',
    path: 'node_modules/@plumbus/auth-cognito/instructions/hosted-login-options.md',
  },
  {
    area: 'Cognito logout URL builder (client_id + logout_uri, no ID-token retention)',
    path: 'node_modules/@plumbus/auth-cognito/instructions/logout.md',
  },
  {
    area: 'testing Cognito integration helpers and registration validation',
    path: 'node_modules/@plumbus/auth-cognito/instructions/testing.md',
  },
  {
    area: 'auth-cognito instruction index and reading order',
    path: 'node_modules/@plumbus/auth-cognito/instructions/README.md',
  },
] as const;

const UPGRADE_INSTRUCTION_REFERENCES = [
  {
    area: 'upgrading to 0.5.x capability invocation (canonical names, invoke policy, flow auth snapshot)',
    path: 'node_modules/@plumbus/core/instructions/upgrading-0.5-capabilities.md',
  },
] as const;

function addInstructionReferenceLines(lines: string[], inline: boolean): void {
  if (inline) {
    lines.push(
      'Refer to the bundled Plumbus instruction files in node_modules (@plumbus/core, @plumbus/ui, and optional add-ons such as chat, chat-ui, voice, voice-openai, voice-livekit, voice-soniox, voice-deepdub, voice-elevenlabs, voice-minimax, knowledge-base, mcp, api, auth, auth-cognito, and browser-extension) for full SDK documentation.',
      'After installing any optional package, open `node_modules/@plumbus/<package>/instructions/README.md` first — that index lists the exact recipe files to read.',
    );
    return;
  }

  lines.push(
    '**Finding recipes:** after `pnpm add @plumbus/<package>`, open `node_modules/@plumbus/<package>/instructions/README.md` first. Paths below are the same files; do not invent wiring from memory.',
  );

  for (const topic of CORE_INSTRUCTION_TOPICS) {
    lines.push(
      `- When working on ${topic}, read \`node_modules/@plumbus/core/instructions/${topic}.md\``,
    );
  }

  for (const reference of UI_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of CHAT_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of CHAT_UI_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of VOICE_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of VOICE_DEEPDUB_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of VOICE_SONIOX_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of VOICE_ELEVENLABS_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of VOICE_MINIMAX_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of VOICE_LIVEKIT_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of VOICE_OPENAI_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of KNOWLEDGE_BASE_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of MCP_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of API_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of BROWSER_EXTENSION_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of AUTH_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of AUTH_COGNITO_INSTRUCTION_REFERENCES) {
    lines.push(`- When working on ${reference.area}, read \`${reference.path}\``);
  }

  for (const reference of UPGRADE_INSTRUCTION_REFERENCES) {
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
- Always declare effects (data, events, external, capabilities, ai)
- Declare invoke targets in \`effects.capabilities\` (canonical \`<domain>.<name>\`) and call them with \`ctx.capabilities.invoke\` — never import other handlers directly
- Set access policies (deny-by-default)
- Use \`ctx.data\`, \`ctx.events\`, \`ctx.ai\` within handlers
- To expose a capability to AI agents over MCP, add \`exposeAs: ["mcp"]\` and optional \`mcp: { description, dangerous, agentTags }\`. Only \`query\`, \`action\`, and \`job\` kinds are eligible.
- To expose a capability on the partner HTTP API, add \`exposeAs: ["api"]\` and optional \`api: { path, method, auth, ... }\`. Only \`query\` and \`action\` kinds are eligible.
- If the task appears to need a custom service, controller, route, or worker, stop and ask which Plumbus primitive should own it instead.
- Never run destructive git commands such as file-overwriting \`git checkout\`, \`git restore\`, \`git reset\`, or \`git clean\` without explicit user approval.
- Reference: \`node_modules/@plumbus/core/instructions/capabilities.md\`, \`node_modules/@plumbus/core/instructions/upgrading-0.5-capabilities.md\` (when migrating pre-0.5 invoke/name patterns), \`node_modules/@plumbus/core/instructions/mcp.md\`, \`node_modules/@plumbus/mcp/instructions/README.md\` (when MCP is installed), \`node_modules/@plumbus/core/instructions/api.md\`, and \`node_modules/@plumbus/api/instructions/README.md\` (when @plumbus/api is installed)
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
