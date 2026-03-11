// ── plumbus prompt new ──
// Scaffold a new prompt

import type { Command } from "commander";
import { promptTemplate } from "../templates/resources.js";
import { error, exists, resolvePath, success, toKebabCase, writeFile } from "../utils.js";

export function registerPromptCommand(program: Command): void {
  const cmd = program.command("prompt").description("Manage prompts");

  cmd
    .command("new <name>")
    .description("Scaffold a new prompt")
    .action((name: string) => {
      const kebab = toKebabCase(name);
      const filePath = resolvePath("app", "prompts", `${kebab}.prompt.ts`);

      if (exists(filePath)) {
        error(`Prompt "${kebab}" already exists`);
        process.exit(1);
      }

      writeFile(filePath, promptTemplate(name));
      success(`Created prompt: app/prompts/${kebab}.prompt.ts`);
    });
}
