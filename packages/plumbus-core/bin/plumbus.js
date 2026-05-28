#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ErrorHints } from "../dist/errors/hints.js";

const PROJECT_MARKERS = [
    "config/app.config.ts",
    "plumbus.config.ts",
    "plumbus.config.json",
];

function isPlumbusProjectRoot(cwd) {
    return PROJECT_MARKERS.some((marker) => existsSync(join(cwd, marker)));
}

// Auto-load .env only inside a recognized Plumbus project (H1)
if (existsSync(".env") && isPlumbusProjectRoot(process.cwd())) {
    process.loadEnvFile(".env");
} else if (existsSync(".env") && !isPlumbusProjectRoot(process.cwd())) {
    console.warn(`[plumbus] ${ErrorHints.envNotLoaded}`);
}

import { createCli } from "../dist/cli/cli.js";
const program = createCli();
program.parse();
