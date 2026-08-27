#!/usr/bin/env node
import { runCli, USAGE } from "../lib/installer.mjs";

try {
  process.exitCode = runCli(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}\n\n${USAGE}`);
  process.exitCode = 1;
}
