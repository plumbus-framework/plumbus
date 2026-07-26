import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateAgentsMd,
  generateCopilotInstructions,
  generateCursorCapabilityRule,
  generateCursorRule,
  generateProjectBrief,
  writeAgentFiles,
} from '../commands/init.js';

describe('plumbus init', () => {
  describe('Copilot instructions', () => {
    it('generates reference-mode instructions', () => {
      const content = generateCopilotInstructions(false);
      expect(content).toContain('Plumbus Framework');
      expect(content).toContain('plumbus:agent-wiring version=10');
      expect(content).toContain('Non-Negotiable Guardrails');
      expect(content).toContain('git checkout');
      expect(content).toContain('node_modules/@plumbus/core/instructions/guardrails.md');
      expect(content).toContain('node_modules/@plumbus/core/instructions/framework.md');
      expect(content).toContain('node_modules/@plumbus/ui/instructions/framework.md');
      expect(content).toContain('node_modules/@plumbus/knowledge-base/instructions/conventions.md');
      expect(content).toContain('node_modules/@plumbus/knowledge-base/instructions/README.md');
      expect(content).toContain('node_modules/@plumbus/chat-ui/instructions/framework.md');
      expect(content).toContain('node_modules/@plumbus/chat-ui/instructions/wiring-chat-panel.md');
      expect(content).toContain('node_modules/@plumbus/chat-ui/instructions/custom-ui.md');
      expect(content).toContain(
        'node_modules/@plumbus/chat-ui/instructions/action-confirmation.md',
      );
      expect(content).toContain('node_modules/@plumbus/chat-ui/instructions/README.md');
      expect(content).toContain('node_modules/@plumbus/voice/instructions/framework.md');
      expect(content).toContain('node_modules/@plumbus/voice/instructions/client-stt.md');
      expect(content).toContain('node_modules/@plumbus/voice/instructions/local-providers.md');
      expect(content).toContain('node_modules/@plumbus/voice/instructions/defining-voices.md');
      expect(content).toContain('node_modules/@plumbus/voice/instructions/providers.md');
      expect(content).toContain('node_modules/@plumbus/voice/instructions/cost-tracking.md');
      expect(content).toContain('node_modules/@plumbus/voice/instructions/testing.md');
      expect(content).toContain('node_modules/@plumbus/voice/instructions/security.md');
      expect(content).toContain('node_modules/@plumbus/mcp/instructions/framework.md');
      expect(content).toContain('node_modules/@plumbus/mcp/instructions/expose-a-capability.md');
      expect(content).toContain('node_modules/@plumbus/mcp/instructions/tasks.md');
      expect(content).toContain('node_modules/@plumbus/mcp/instructions/testing.md');
      expect(content).toContain('node_modules/@plumbus/mcp/instructions/README.md');
      expect(content).toContain('node_modules/@plumbus/api/instructions/framework.md');
      expect(content).toContain('node_modules/@plumbus/api/instructions/expose-a-capability.md');
      expect(content).toContain('node_modules/@plumbus/api/instructions/manifest-and-cli.md');
      expect(content).toContain('node_modules/@plumbus/api/instructions/testing.md');
      expect(content).toContain('node_modules/@plumbus/api/instructions/README.md');
      expect(content).toContain(
        'node_modules/@plumbus/browser-extension/instructions/browser-extension.md',
      );
      expect(content).toContain('node_modules/@plumbus/auth/instructions/framework.md');
      expect(content).toContain('node_modules/@plumbus/auth/instructions/configure-runtime.md');
      expect(content).toContain('node_modules/@plumbus/auth/instructions/providers.md');
      expect(content).toContain('node_modules/@plumbus/auth/instructions/sessions-and-csrf.md');
      expect(content).toContain('node_modules/@plumbus/auth/instructions/resolvers.md');
      expect(content).toContain('node_modules/@plumbus/auth/instructions/testing.md');
      expect(content).toContain('node_modules/@plumbus/auth/instructions/README.md');
      expect(content).toContain('node_modules/@plumbus/auth-cognito/instructions/framework.md');
      expect(content).toContain(
        'node_modules/@plumbus/auth-cognito/instructions/configure-cognito.md',
      );
      expect(content).toContain(
        'node_modules/@plumbus/auth-cognito/instructions/hosted-login-options.md',
      );
      expect(content).toContain('node_modules/@plumbus/auth-cognito/instructions/logout.md');
      expect(content).toContain('node_modules/@plumbus/auth-cognito/instructions/testing.md');
      expect(content).toContain('node_modules/@plumbus/auth-cognito/instructions/README.md');
      expect(content).toContain('node_modules/@plumbus/core/instructions/capabilities.md');
      expect(content).toContain(
        'node_modules/@plumbus/core/instructions/upgrading-0.5-capabilities.md',
      );
      expect(content).toContain('Edit Zones');
      expect(content).toContain('plumbus ui generate');
      expect(content).toContain('Documentation Maintenance');
      expect(content).toContain('app/entities/');
      expect(content).toContain('docs/architecture/data-model.md');
      expect(content).toContain('<!-- /plumbus:agent-wiring -->');
    });

    it('generates inline-mode instructions', () => {
      const content = generateCopilotInstructions(true);
      expect(content).toContain('Plumbus Framework');
      expect(content).toContain('plumbus:agent-wiring version=10');
      expect(content).toContain('Non-Negotiable Guardrails');
      expect(content).toContain('bundled Plumbus instruction files');
      expect(content).not.toContain('node_modules/@plumbus/core/instructions/');
      expect(content).toContain('Documentation Maintenance');
    });
  });

  describe('Cursor rules', () => {
    it('generates main rule with frontmatter', () => {
      const content = generateCursorRule(false);
      expect(content).toContain('---');
      expect(content).toContain('description:');
      expect(content).toContain('globs: app/**');
      expect(content).toContain('plumbus:agent-wiring version=10');
      expect(content).toContain('Non-Negotiable Guardrails');
      expect(content).toContain('git reset');
      expect(content).toContain('node_modules/@plumbus/core/instructions/');
      expect(content).toContain('node_modules/@plumbus/ui/instructions/');
      expect(content).toContain('Documentation Maintenance');
      expect(content).toContain('<!-- /plumbus:agent-wiring -->');
    });

    it('generates capability-specific rule', () => {
      const content = generateCursorCapabilityRule();
      expect(content).toContain('globs: app/capabilities/**');
      expect(content).toContain('defineCapability()');
      expect(content).toContain('plumbus:agent-wiring version=10');
      expect(content).toContain('ctx.capabilities.invoke');
      expect(content).toContain('exposeAs: ["api"]');
      expect(content).toContain(
        'node_modules/@plumbus/core/instructions/upgrading-0.5-capabilities.md',
      );
      expect(content).toContain('node_modules/@plumbus/api/instructions/README.md');
      expect(content).toContain('custom service, controller, route, or worker');
      expect(content).toContain('git clean');
      expect(content).toContain('<!-- /plumbus:agent-wiring -->');
    });
  });

  describe('AGENTS.md', () => {
    it('generates agent-agnostic reference format', () => {
      const content = generateAgentsMd(false);
      expect(content).toContain('AGENTS.md');
      expect(content).toContain('plumbus:agent-wiring version=10');
      expect(content).toContain('Directory Structure');
      expect(content).toContain('Edit Zones');
      expect(content).toContain('Non-Negotiable Guardrails');
      expect(content).toContain('git restore');
      expect(content).toContain('node_modules/@plumbus/core/instructions/guardrails.md');
      expect(content).toContain('node_modules/@plumbus/core/instructions/');
      expect(content).toContain('node_modules/@plumbus/ui/instructions/');
      expect(content).toContain('Documentation Maintenance');
      expect(content).toContain('app/capabilities/');
      expect(content).toContain('docs/capabilities/index.md');
      expect(content).toContain('<!-- /plumbus:agent-wiring -->');
    });

    it('generates inline format', () => {
      const content = generateAgentsMd(true);
      expect(content).toContain('plumbus:agent-wiring version=10');
      expect(content).toContain('Non-Negotiable Guardrails');
      expect(content).toContain('bundled Plumbus instruction files');
      expect(content).not.toContain('node_modules/@plumbus/core/instructions/');
      expect(content).toContain('Documentation Maintenance');
    });
  });

  describe('Project brief', () => {
    it('generates a placeholder brief', () => {
      const brief = generateProjectBrief();
      expect(brief).toContain('Project Brief');
      expect(brief).toContain('plumbus agent sync');
    });

    it('can skip writing the placeholder brief', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-'));

      try {
        const written = writeAgentFiles(tempDir, ['copilot'], false, false);
        expect(written.map((result) => result.path)).toContain('.github/copilot-instructions.md');
        expect(written.map((result) => result.path)).not.toContain('.plumbus/briefs/project.md');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('writeAgentFiles', () => {
    it('skips existing files in default create mode', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-'));
      const filePath = path.join(tempDir, '.github', 'copilot-instructions.md');

      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, 'custom instructions', 'utf-8');

        const results = writeAgentFiles(tempDir, ['copilot'], false, false);
        expect(results[0]?.action).toBe('skipped');
        expect(results[0]?.message).toContain('--patch');
        expect(readFileSync(filePath, 'utf-8')).toBe('custom instructions');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('patches v8 wiring to the current version and adds auth instruction references', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-'));
      const filePath = path.join(tempDir, '.github', 'copilot-instructions.md');

      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        const v8WithoutAuth = generateCopilotInstructions(false)
          .replace(/plumbus:agent-wiring version=10/g, 'plumbus:agent-wiring version=8')
          .split('\n')
          .filter((line) => !line.includes('@plumbus/auth'))
          .join('\n');
        writeFileSync(filePath, v8WithoutAuth, 'utf-8');

        const results = writeAgentFiles(tempDir, ['copilot'], false, false, false, 'patch');
        const updated = readFileSync(filePath, 'utf-8');

        expect(results[0]?.action).toBe('patched');
        expect(updated).toContain('plumbus:agent-wiring version=10');
        expect(updated).toContain('node_modules/@plumbus/auth/instructions/framework.md');
        expect(updated).toContain(
          'node_modules/@plumbus/auth-cognito/instructions/configure-cognito.md',
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('patches v9 wiring to v10 and adds the loginContext admission pointer', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-'));
      const filePath = path.join(tempDir, '.github', 'copilot-instructions.md');

      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        const v9 = generateCopilotInstructions(false)
          .replace(/plumbus:agent-wiring version=10/g, 'plumbus:agent-wiring version=9')
          .replace(/, and invitation-only admission via loginContext[^|\n]*/g, '');
        writeFileSync(filePath, v9, 'utf-8');
        expect(v9).not.toContain('invitation-only admission via loginContext');

        const results = writeAgentFiles(tempDir, ['copilot'], false, false, false, 'patch');
        const updated = readFileSync(filePath, 'utf-8');

        expect(results[0]?.action).toBe('patched');
        expect(updated).toContain('plumbus:agent-wiring version=10');
        expect(updated).toContain('invitation-only admission via loginContext');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('patches managed wiring blocks and preserves surrounding user notes', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-'));
      const filePath = path.join(tempDir, '.github', 'copilot-instructions.md');

      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        const original = [
          '<!-- user note -->',
          generateCopilotInstructions(false).replace(
            '## Non-Negotiable Guardrails',
            '## Old Guardrails',
          ),
          '<!-- user footer -->',
        ].join('\n');
        writeFileSync(filePath, original, 'utf-8');

        const results = writeAgentFiles(tempDir, ['copilot'], false, false, false, 'patch');
        const updated = readFileSync(filePath, 'utf-8');

        expect(results[0]?.action).toBe('patched');
        expect(updated).toContain('<!-- user note -->');
        expect(updated).toContain('<!-- user footer -->');
        expect(updated).toContain('## Non-Negotiable Guardrails');
        expect(updated).not.toContain('## Old Guardrails');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('creates missing files in patch mode', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-'));

      try {
        const results = writeAgentFiles(tempDir, ['copilot'], false, false, false, 'patch');
        expect(results[0]?.action).toBe('created');
        expect(results[0]?.path).toBe('.github/copilot-instructions.md');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('skips unmanaged files in patch mode', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-'));
      const filePath = path.join(tempDir, '.github', 'copilot-instructions.md');

      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, 'custom instructions', 'utf-8');

        const results = writeAgentFiles(tempDir, ['copilot'], false, false, false, 'patch');
        expect(results[0]?.action).toBe('skipped');
        expect(results[0]?.message).toContain('--force');
        expect(readFileSync(filePath, 'utf-8')).toBe('custom instructions');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('replaces existing files in force mode', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-'));
      const filePath = path.join(tempDir, '.github', 'copilot-instructions.md');

      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, 'custom instructions', 'utf-8');

        const results = writeAgentFiles(tempDir, ['copilot'], false, false, false, 'force');
        const updated = readFileSync(filePath, 'utf-8');

        expect(results[0]?.action).toBe('replaced');
        expect(updated).toContain('plumbus:agent-wiring version=10');
        expect(updated).not.toBe('custom instructions');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('preserves an existing project brief even in force mode', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-'));
      const briefPath = path.join(tempDir, '.plumbus', 'briefs', 'project.md');

      try {
        mkdirSync(path.dirname(briefPath), { recursive: true });
        writeFileSync(briefPath, 'custom brief', 'utf-8');

        const results = writeAgentFiles(tempDir, ['copilot'], false, true, false, 'force');
        const briefResult = results.find((result) => result.path === '.plumbus/briefs/project.md');
        expect(briefResult?.action).toBe('skipped');
        expect(readFileSync(briefPath, 'utf-8')).toBe('custom brief');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Monorepo mode', () => {
    it('generates copilot instructions with backend/ paths', () => {
      const content = generateCopilotInstructions(false, true);
      expect(content).toContain('backend/app/capabilities/');
      expect(content).toContain('backend/app/entities/');
      expect(content).toContain('backend/config/');
      expect(content).toContain('frontend/');
      expect(content).toContain('libs/shared/types/');
      expect(content).toContain('Non-Negotiable Guardrails');
    });

    it('generates cursor rule with backend/ glob', () => {
      const content = generateCursorRule(false, true);
      expect(content).toContain('globs: backend/app/**');
      expect(content).toContain('backend/app/capabilities/');
      expect(content).toContain('Non-Negotiable Guardrails');
    });

    it('generates AGENTS.md with monorepo structure', () => {
      const content = generateAgentsMd(false, true);
      expect(content).toContain('backend/app/capabilities/');
      expect(content).toContain('frontend/');
      expect(content).toContain('libs/shared/types/');
      expect(content).toContain('Non-Negotiable Guardrails');
    });

    it('passes monorepo flag through writeAgentFiles', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-mono-'));
      try {
        const written = writeAgentFiles(tempDir, ['copilot', 'agents-md'], false, false, true);
        expect(written.map((result) => result.path)).toContain('.github/copilot-instructions.md');
        expect(written.map((result) => result.path)).toContain('AGENTS.md');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
