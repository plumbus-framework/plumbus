// ── plumbus capability new ──
// Scaffold a new capability

import type { Command } from "commander";
import * as path from "node:path";
import { capabilityTemplate, capabilityTestTemplate } from "../templates/resources.js";
import { error, exists, resolvePath, success, toKebabCase, writeFile } from "../utils.js";

export interface CapabilityNewOptions {
  kind?: string;
  domain?: string;
}

export function registerCapabilityCommand(program: Command): void {
  const cmd = program.command("capability").description("Manage capabilities");

  cmd
    .command("new <name>")
    .description("Scaffold a new capability")
    .option("--kind <kind>", "Capability kind: query, action, job, eventHandler", "action")
    .option("--domain <domain>", "Domain name", "default")
    .action((name: string, opts: CapabilityNewOptions) => {
      const kind = opts.kind ?? "action";
      const domain = opts.domain ?? "default";
      const kebab = toKebabCase(name);
      const baseDir = resolvePath("app", "capabilities", domain, kebab);

      if (exists(baseDir)) {
        error(`Capability "${kebab}" already exists in domain "${domain}"`);
        process.exit(1);
      }

      writeFile(
        path.join(baseDir, "capability.ts"),
        capabilityTemplate(name, kind, domain),
      );
      writeFile(
        path.join(baseDir, "tests", `${kebab}.test.ts`),
        capabilityTestTemplate(name, domain),
      );

      success(`Created capability: app/capabilities/${domain}/${kebab}/`);
    });
}
