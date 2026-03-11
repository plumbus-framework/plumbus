// ── plumbus flow new ──
// Scaffold a new flow

import type { Command } from "commander";
import * as path from "node:path";
import { flowTemplate } from "../templates/resources.js";
import { error, exists, resolvePath, success, toKebabCase, writeFile } from "../utils.js";

export function registerFlowCommand(program: Command): void {
  const cmd = program.command("flow").description("Manage flows");

  cmd
    .command("new <name>")
    .description("Scaffold a new flow")
    .option("--domain <domain>", "Domain name", "default")
    .action((name: string, opts: { domain?: string }) => {
      const domain = opts.domain ?? "default";
      const kebab = toKebabCase(name);
      const baseDir = resolvePath("app", "flows", domain, kebab);

      if (exists(baseDir)) {
        error(`Flow "${kebab}" already exists in domain "${domain}"`);
        process.exit(1);
      }

      writeFile(path.join(baseDir, "flow.ts"), flowTemplate(name, domain));

      success(`Created flow: app/flows/${domain}/${kebab}/`);
    });
}
