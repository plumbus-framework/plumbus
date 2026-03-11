// ── plumbus event new ──
// Scaffold a new event

import type { Command } from "commander";
import { eventTemplate } from "../templates/resources.js";
import { error, exists, resolvePath, success, toKebabCase, writeFile } from "../utils.js";

export function registerEventCommand(program: Command): void {
  const cmd = program.command("event").description("Manage events");

  cmd
    .command("new <name>")
    .description("Scaffold a new event")
    .action((name: string) => {
      const kebab = toKebabCase(name);
      const filePath = resolvePath("app", "events", `${kebab}.event.ts`);

      if (exists(filePath)) {
        error(`Event "${kebab}" already exists`);
        process.exit(1);
      }

      writeFile(filePath, eventTemplate(name));
      success(`Created event: app/events/${kebab}.event.ts`);
    });
}
