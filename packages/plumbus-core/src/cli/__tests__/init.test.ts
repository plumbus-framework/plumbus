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
      expect(content).toContain('node_modules/plumbus-core/instructions/framework.md');
      expect(content).toContain('node_modules/@plumbus/ui/instructions/framework.md');
      expect(content).toContain('node_modules/plumbus-core/instructions/capabilities.md');
      expect(content).toContain('Edit Zones');
      expect(content).toContain('plumbus ui generate');
    });

    it('generates inline-mode instructions', () => {
      const content = generateCopilotInstructions(true);
      expect(content).toContain('Plumbus Framework');
      expect(content).toContain('framework and UI instruction files');
      // Should not reference node_modules in SDK Reference section
      expect(content).not.toContain('node_modules/plumbus-core/instructions/');
    });
  });

  describe('Cursor rules', () => {
    it('generates main rule with frontmatter', () => {
      const content = generateCursorRule(false);
      expect(content).toContain('---');
      expect(content).toContain('description:');
      expect(content).toContain('globs: app/**');
      expect(content).toContain('node_modules/plumbus-core/instructions/');
      expect(content).toContain('node_modules/@plumbus/ui/instructions/');
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
      expect(content).toContain('node_modules/plumbus-core/instructions/');
      expect(content).toContain('node_modules/@plumbus/ui/instructions/');
    });

    it('generates inline format', () => {
      const content = generateAgentsMd(true);
      expect(content).toContain('framework and UI instruction files');
      // Should not reference node_modules in SDK Reference section
      expect(content).not.toContain('node_modules/plumbus-core/instructions/');
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
});
