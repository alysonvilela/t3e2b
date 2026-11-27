#!/usr/bin/env bun
// `t3e2b` with no arguments starts the MCP server (stdio); with arguments it is the CLI.
// Bun runs the TypeScript sources directly and loads .env from the working directory.
if (process.argv.length > 2) await import("../src/cli.ts");
else await import("../src/index.ts");

export {};
