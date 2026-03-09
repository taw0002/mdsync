#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startMcpServer } from './src/mcp.js';
import {
  BUILD_COMMAND,
  VIEW_COMMANDS,
  parseArgs,
  printUsage,
  startStaticBuild,
  startViewerFromArgs,
} from './src/mdview-core.js';

const __filename = fileURLToPath(import.meta.url);

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'mcp') {
    await startMcpServer();
    return;
  }

  if (args.command === BUILD_COMMAND) {
    const result = await startStaticBuild(args);
    console.log(`Built ${result.documentCount} markdown file${result.documentCount === 1 ? '' : 's'} into ${result.outDir}`);
    return;
  }

  if (!args.command || !VIEW_COMMANDS.has(args.command)) {
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

const resolveArgv1 = () => {
  if (!process.argv[1]) return null;
  try {
    return fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return path.resolve(process.argv[1]);
  }
};
const isCliEntryPoint = resolveArgv1() === fs.realpathSync(__filename);

if (isCliEntryPoint) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
