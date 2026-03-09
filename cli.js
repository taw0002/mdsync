#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startMcpServer } from './src/mcp.js';
import { VIEW_COMMANDS, parseArgs, printUsage, startViewerFromArgs } from './src/mdview-core.js';

const __filename = fileURLToPath(import.meta.url);

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'mcp') {
    await startMcpServer();
    return;
  }

  if (!VIEW_COMMANDS.has(args.command)) {
    printUsage(args.command ? 1 : 0);
    return;
  }

  const session = await startViewerFromArgs(args);

  console.log(`${args.command === 'serve' ? 'Serving' : 'Viewing'} ${session.filePath}`);
  console.log(session.url);

  const shutdown = async () => {
    await session.shutdown();
  };

  process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
  });
}

const isCliEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isCliEntryPoint) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
