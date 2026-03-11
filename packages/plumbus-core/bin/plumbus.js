#!/usr/bin/env node
import { createCli } from "../dist/cli/cli.js";
const program = createCli();
program.parse();
