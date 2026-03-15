#!/usr/bin/env node
import { existsSync } from "node:fs";

// Auto-load .env file if present (Node 20.6+ built-in)
if (existsSync(".env")) {
    process.loadEnvFile(".env");
}

import { createCli } from "../dist/cli/cli.js";
const program = createCli();
program.parse();
