import { mkdtempSync, rmSync } from 'node:fs';
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
      expect(content).toContain('node_modules/@plumbus/core/instructions/framework.md');
      expect(content).toContain('node_modules/@plumbus/ui/instructions/framework.md');
      expect(content).toContain('node_modules/@plumbus/core/instructions/capabilities.md');
      expect(content).toContain('Edit Zones');
      expect(content).toContain('plumbus ui generate');
      expect(content).toContain('Documentation Maintenance');
      expect(content).toContain('app/entities/');
      expect(content).toContain('docs/architecture/data-model.md');
    });

    it('generates inline-mode instructions', () => {
      const content = generateCopilotInstructions(true);
      expect(content).toContain('Plumbus Framework');
      expect(content).toContain('framework and UI instruction files');
      // Should not reference node_modules in SDK Reference section
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
      expect(content).toContain('node_modules/@plumbus/core/instructions/');
      expect(content).toContain('node_modules/@plumbus/ui/instructions/');
      expect(content).toContain('Documentation Maintenance');
    });

    it('generates capability-specific rule', () => {
      const content = generateCursorCapabilityRule();
      expect(content).toContain('globs: app/capabilities/**');
      expect(content).toContain('defineCapability()');
    });
  });

  describe('AGENTS.md', () => {
    it('generates agent-agnostic reference format', () => {
      const content = generateAgentsMd(false);
      expect(content).toContain('AGENTS.md');
      expect(content).toContain('Directory Structure');
      expect(content).toContain('Edit Zones');
      expect(content).toContain('node_modules/@plumbus/core/instructions/');
      expect(content).toContain('node_modules/@plumbus/ui/instructions/');
      expect(content).toContain('Documentation Maintenance');
      expect(content).toContain('app/capabilities/');
      expect(content).toContain('docs/capabilities/index.md');
    });

    it('generates inline format', () => {
      const content = generateAgentsMd(true);
      expect(content).toContain('framework and UI instruction files');
      // Should not reference node_modules in SDK Reference section
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
        expect(written).toContain('.github/copilot-instructions.md');
        expect(written).not.toContain('.plumbus/briefs/project.md');
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
    });

    it('generates cursor rule with backend/ glob', () => {
      const content = generateCursorRule(false, true);
      expect(content).toContain('globs: backend/app/**');
      expect(content).toContain('backend/app/capabilities/');
    });

    it('generates AGENTS.md with monorepo structure', () => {
      const content = generateAgentsMd(false, true);
      expect(content).toContain('backend/app/capabilities/');
      expect(content).toContain('frontend/');
      expect(content).toContain('libs/shared/types/');
    });

    it('passes monorepo flag through writeAgentFiles', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'plumbus-init-mono-'));
      try {
        const written = writeAgentFiles(tempDir, ['copilot', 'agents-md'], false, false, true);
        expect(written).toContain('.github/copilot-instructions.md');
        expect(written).toContain('AGENTS.md');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
