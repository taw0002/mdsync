import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  DEFAULT_PORT,
  getFeedbackPath,
  openBrowser,
  printUsage,
  readDocument,
  readFeedbackDocument,
  startViewerFromArgs,
} from './mdview-core.js';

let viewerSession = null;

export async function startMcpServer() {
  const server = new McpServer({
    name: 'mdview',
    version: '0.2.0',
  });

  server.registerTool('present', {
    description: 'Open a markdown document in mdview. Starts the browser viewer if needed.',
    inputSchema: {
      path: z.string().describe('Absolute or relative path to a markdown file or directory'),
    },
  }, async ({ path: inputPath }) => {
    const resolvedPath = path.resolve(process.cwd(), inputPath);

    if (viewerSession) {
      await viewerSession.shutdown();
      viewerSession = null;
    }

    viewerSession = await startViewerFromArgs({
      command: 'view',
      target: resolvedPath,
      port: DEFAULT_PORT,
      light: false,
      noEdit: false,
      noOpen: true,
    });

    openBrowser(viewerSession.url);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            url: viewerSession.url,
            file: viewerSession.filePath,
            feedbackPath: getFeedbackPath(viewerSession.filePath),
          }, null, 2),
        },
      ],
    };
  });

  server.registerTool('get_feedback', {
    description: 'Return the structured feedback JSON stored next to the markdown file.',
    inputSchema: {
      path: z.string().describe('Path to the markdown file'),
    },
  }, async ({ path: inputPath }) => {
    const resolvedPath = path.resolve(process.cwd(), inputPath);
    const feedback = await readFeedbackDocument(resolvedPath);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(feedback, null, 2),
        },
      ],
    };
  });

  server.registerTool('get_document', {
    description: 'Return the current markdown content for a document.',
    inputSchema: {
      path: z.string().describe('Path to the markdown file'),
    },
  }, async ({ path: inputPath }) => {
    const resolvedPath = path.resolve(process.cwd(), inputPath);
    const content = await readDocument(resolvedPath);
    return {
      content: [
        {
          type: 'text',
          text: content,
        },
      ],
    };
  });

  server.registerTool('watch', {
    description: 'Stubbed watch tool for future change subscriptions.',
    inputSchema: {
      path: z.string().describe('Path to the markdown file'),
    },
  }, async ({ path: inputPath }) => {
    return {
      content: [
        {
          type: 'text',
          text: `watch is not implemented yet for ${path.resolve(process.cwd(), inputPath)}`,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { printUsage };
