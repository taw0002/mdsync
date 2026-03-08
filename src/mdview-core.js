import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import chokidar from 'chokidar';
import { marked } from 'marked';
import { WebSocketServer } from 'ws';

export const DEFAULT_PORT = 3456;
export const VIEW_COMMANDS = new Set(['view', 'serve']);

const THEMES = {
  dark: {
    shiki: 'github-dark-default',
  },
  light: {
    shiki: 'github-light',
  },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let highlighterPromise = null;
let editorBundlePromise = null;
const highlighterCache = new Map();

export function parseArgs(argv) {
  const result = {
    command: argv[0] ?? null,
    target: undefined,
    port: DEFAULT_PORT,
    light: false,
    noEdit: false,
    noOpen: false,
  };

  let index = 1;
  while (index < argv.length) {
    const token = argv[index];

    if (!token.startsWith('-') && result.target === undefined) {
      result.target = token;
      index += 1;
      continue;
    }

    if (token === '--port' || token === '-p') {
      result.port = Number(argv[index + 1] ?? DEFAULT_PORT);
      index += 2;
      continue;
    }

    if (token === '--light') {
      result.light = true;
      index += 1;
      continue;
    }

    if (token === '--no-edit') {
      result.noEdit = true;
      index += 1;
      continue;
    }

    if (token === '--no-open') {
      result.noOpen = true;
      index += 1;
      continue;
    }

    if (token === '--help' || token === '-h') {
      result.command = null;
      index = argv.length;
      continue;
    }

    result.target = result.target ?? token;
    index += 1;
  }

  return result;
}

export function printUsage(exitCode) {
  console.log(`md - Beautiful Markdown Viewer & Editor CLI

Usage:
  md view file.md
  md view .
  md serve .
  md serve ./docs -p 3333
  md mcp

Options:
  --port, -p    Port (default: 3456)
  --light       Light theme
  --no-edit     Disable editing
  --no-open     Don't auto-open browser`);
  process.exitCode = exitCode;
}

export async function startViewerFromArgs(args) {
  const rootInput = args.target ?? '.';
  const rootPath = path.resolve(process.cwd(), rootInput);
  const stats = safeStat(rootPath);

  if (!stats) {
    throw new Error(`Path not found: ${rootPath}`);
  }

  const explicitServe = args.command === 'serve';
  const isDirectoryMode = explicitServe || stats.isDirectory();
  const rootDir = stats.isDirectory() ? rootPath : path.dirname(rootPath);
  const filePath = isDirectoryMode ? resolveInitialFile(rootPath, explicitServe) : rootPath;

  if (!filePath) {
    throw new Error(`No markdown files found in ${rootPath}`);
  }

  const appState = createAppState({
    rootDir,
    mode: isDirectoryMode ? 'directory' : 'file',
    currentFile: filePath,
    editable: !args.noEdit,
    defaultTheme: args.light ? 'light' : 'dark',
  });

  const server = createHttpServer(appState);
  const wss = new WebSocketServer({ noServer: true });

  appState.broadcast = (payload) => {
    const json = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(json);
      }
    }
  };

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', async (ws) => {
    ws.send(JSON.stringify({
      type: 'ready',
      path: normalizeSlashes(appState.currentFile),
      feedbackPath: normalizeSlashes(getFeedbackPath(appState.currentFile)),
    }));
  });

  const watchTarget = appState.mode === 'directory' ? appState.rootDir : path.dirname(appState.currentFile);
  const watcher = chokidar.watch([watchTarget], {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 30,
    },
  });

  const notifyChange = (file) => {
    const absoluteFile = path.resolve(file);
    const normalized = normalizeSlashes(absoluteFile);
    const isMarkdown = absoluteFile.toLowerCase().endsWith('.md');
    const isFeedback = absoluteFile.toLowerCase().endsWith('.feedback.json');

    if (!isMarkdown && !isFeedback) {
      return;
    }

    if (appState.mode === 'file') {
      const feedbackPath = getFeedbackPath(appState.currentFile);
      if (absoluteFile !== appState.currentFile && absoluteFile !== feedbackPath) {
        return;
      }

      appState.broadcast({
        type: isFeedback ? 'feedback-changed' : 'file-changed',
        path: normalized,
        currentPath: normalizeSlashes(appState.currentFile),
      });
      return;
    }

    if (isMarkdown) {
      appState.broadcast({
        type: 'directory-changed',
        path: normalized,
        files: listMarkdownFiles(appState.rootDir),
      });
    }

    appState.broadcast({
      type: isFeedback ? 'feedback-changed' : 'file-changed',
      path: normalized,
      relativePath: normalizeSlashes(path.relative(appState.rootDir, file.replace(/\.feedback\.json$/i, ''))),
    });
  };

  watcher.on('add', notifyChange);
  watcher.on('change', notifyChange);
  watcher.on('unlink', notifyChange);

  const port = await listen(server, Number.isFinite(args.port) ? args.port : DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}`;

  if (!args.noOpen) {
    openBrowser(url);
  }

  const shutdown = async () => {
    await watcher.close();
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    appState,
    port,
    url,
    shutdown,
    filePath,
    mode: appState.mode,
  };
}

export function openBrowser(url) {
  const platform = os.platform();

  if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function createAppState({ rootDir, mode, currentFile, editable, defaultTheme }) {
  return {
    rootDir,
    mode,
    currentFile: path.resolve(currentFile),
    editable,
    defaultTheme,
    broadcast: () => {},
  };
}

function createHttpServer(appState) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname === '/') {
        const theme = resolveTheme(url.searchParams.get('theme'), appState.defaultTheme);
        const html = await renderAppShell(appState, theme);
        send(response, 200, html, 'text/html; charset=utf-8');
        return;
      }

      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/doc') {
        const requestedPath = getResolvedDocumentPath(appState, url.searchParams.get('path'));
        const theme = resolveTheme(url.searchParams.get('theme'), appState.defaultTheme);
        const doc = await buildDocumentPayload(appState, requestedPath, theme);
        sendJson(response, 200, doc);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/files') {
        if (appState.mode !== 'directory') {
          sendJson(response, 400, { error: 'Files endpoint is only available in directory mode.' });
          return;
        }
        sendJson(response, 200, { files: listMarkdownFiles(appState.rootDir) });
        return;
      }

      if (request.method === 'PUT' && url.pathname === '/api/save') {
        if (!appState.editable) {
          sendJson(response, 403, { error: 'Editing is disabled.' });
          return;
        }

        const body = await readRequestBody(request);
        const payload = JSON.parse(body || '{}');
        const requestedPath = getResolvedDocumentPath(appState, payload.path);
        const result = await writeMarkdownChange(requestedPath, payload);
        sendJson(response, 200, { ok: true, change: result.change });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/feedback') {
        const requestedPath = getResolvedDocumentPath(appState, url.searchParams.get('path'));
        const feedback = await readFeedbackDocument(requestedPath);
        sendJson(response, 200, feedback);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/feedback') {
        const body = await readRequestBody(request);
        const payload = JSON.parse(body || '{}');
        const requestedPath = getResolvedDocumentPath(appState, payload.path);
        const feedback = await appendFeedbackChange(requestedPath, payload);
        sendJson(response, 200, feedback);
        return;
      }

      if (request.method === 'DELETE' && url.pathname.startsWith('/api/feedback/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/feedback/'.length));
        const requestedPath = getResolvedDocumentPath(appState, url.searchParams.get('path'));
        const feedback = await deleteFeedbackChange(requestedPath, id);
        sendJson(response, 200, feedback);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/send-feedback') {
        const body = await readRequestBody(request);
        const payload = JSON.parse(body || '{}');
        const requestedPath = getResolvedDocumentPath(appState, payload.path);
        const feedback = await markFeedbackSubmitted(requestedPath);
        appState.broadcast({
          type: 'feedback-submitted',
          path: normalizeSlashes(requestedPath),
          feedbackPath: normalizeSlashes(getFeedbackPath(requestedPath)),
          reviewedAt: feedback.reviewedAt,
        });
        sendJson(response, 200, feedback);
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, 500, { error: error.message || String(error) });
    }
  });
}

async function renderAppShell(appState, themeName) {
  const [initialDoc, initialFeedback, editorBundle] = await Promise.all([
    buildDocumentPayload(appState, appState.currentFile, themeName),
    readFeedbackDocument(appState.currentFile),
    readEditorBundle(),
  ]);

  const fileTree = appState.mode === 'directory' ? listMarkdownFiles(appState.rootDir) : [];

  const state = {
    mode: appState.mode,
    rootDir: appState.rootDir,
    currentPath: initialDoc.relativePath,
    currentTitle: initialDoc.title,
    editable: appState.editable,
    defaultTheme: appState.defaultTheme,
    initialDoc,
    initialFeedback,
    fileTree,
  };

  return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(appState.defaultTheme)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(initialDoc.title)}</title>
  <style>
${buildStyles()}
  </style>
</head>
<body>
  <div class="app-shell">
    <header class="topbar">
      <div class="topbar__meta">
        <button class="sidebar-toggle" id="sidebarToggle" aria-label="Toggle sidebar">
          <span></span>
          <span></span>
        </button>
        <div>
          <div class="eyebrow">${appState.mode === 'directory' ? 'Directory mode' : 'Single file'}</div>
          <div class="page-title" id="pageTitle">${escapeHtml(initialDoc.title)}</div>
        </div>
      </div>
      <div class="topbar__actions">
        <button class="chip" id="searchTrigger">Cmd+K Search</button>
        ${appState.editable ? '<button class="chip" id="editModeButton">Edit</button><button class="chip accent" id="saveEditButton" hidden>Save</button><button class="chip" id="cancelEditButton" hidden>Cancel</button>' : ''}
        <button class="chip accent" id="sendFeedbackButton">Send Feedback</button>
        <button class="chip" id="themeToggle" aria-label="Toggle theme">Toggle theme</button>
      </div>
    </header>

    <div class="layout" id="layout">
      <aside class="sidebar" id="sidebar">
        ${appState.mode === 'directory' ? '<section class="sidebar-section"><div class="sidebar-label">Files</div><nav id="fileTree" class="file-tree"></nav></section>' : ''}
        <section class="sidebar-section">
          <div class="sidebar-label">Contents</div>
          <nav id="toc" class="toc"></nav>
        </section>
      </aside>

      <main class="viewer" id="viewer">
        <article class="doc" id="docRoot">${initialDoc.html}</article>
      </main>

      <aside class="feedback-panel" id="feedbackPanel">
        <div class="feedback-panel__header">
          <div>
            <div class="sidebar-label">Feedback</div>
            <div class="feedback-panel__title" id="feedbackTitle">Targeted review</div>
          </div>
          <div class="feedback-panel__count" id="feedbackCount">0</div>
        </div>
        <div class="feedback-panel__meta" id="feedbackMeta"></div>
        <div class="feedback-list" id="feedbackList"></div>
      </aside>
    </div>
  </div>

  <div class="search-palette hidden" id="searchPalette" aria-hidden="true">
    <div class="search-backdrop" data-close-search="true"></div>
    <div class="search-dialog" role="dialog" aria-modal="true" aria-label="Search">
      <div class="search-input-wrap">
        <input id="searchInput" type="text" placeholder="Search headings and content..." autocomplete="off" />
      </div>
      <div class="search-results" id="searchResults"></div>
    </div>
  </div>

  <div id="floatingToolbarRoot"></div>
  <div id="composerRoot"></div>
  <div class="status-toast" id="statusToast" hidden></div>

  <script>
    window.__MDVIEW__ = ${serializeForScript(state)};
  </script>
  <script>
${editorBundle}
  </script>
</body>
</html>`;
}

async function readEditorBundle() {
  if (!editorBundlePromise) {
    editorBundlePromise = (async () => {
      const bundlePath = path.resolve(__dirname, '..', 'dist', 'editor.bundle.js');
      try {
        return await readFile(bundlePath, 'utf8');
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          throw new Error(`Missing ${bundlePath}. Run "npm run build" before launching mdview.`);
        }
        throw error;
      }
    })();
  }

  return editorBundlePromise;
}

export async function buildDocumentPayload(appState, filePath, themeName) {
  const source = await readFile(filePath, 'utf8');
  const blocks = splitMarkdownBlocks(source);
  const headings = [];
  const slugCounts = new Map();
  let currentSection = path.basename(filePath);

  for (const block of blocks) {
    if (block.type === 'heading') {
      const text = block.markdown.replace(/^#{1,6}\s+/, '').trim();
      const depth = Math.max(1, Math.min(6, countHeadingDepth(block.markdown)));
      const slug = uniqueSlug(text, slugCounts);
      block.heading = { text, depth, slug };
      currentSection = text || currentSection;
      headings.push({
        id: slug,
        text,
        depth,
        startLine: block.startLine,
      });
    }

    block.section = currentSection;
  }

  const renderedBlocks = [];
  const blockPayloads = [];

  for (const block of blocks) {
    const rendered = await renderBlock(block, themeName);
    renderedBlocks.push(rendered.shellHtml);
    blockPayloads.push({
      id: rendered.id,
      type: block.type,
      startLine: block.startLine,
      endLine: block.endLine,
      section: block.section,
      markdown: block.markdown,
      searchText: stripMarkdownForSearch(block.markdown),
      previewHtml: rendered.previewHtml,
      heading: block.heading ?? null,
    });
  }

  const relativePath = normalizeSlashes(path.relative(appState.rootDir, filePath));
  return {
    title: path.basename(filePath),
    fileName: path.basename(filePath),
    relativePath,
    absolutePath: filePath,
    html: renderedBlocks.join('\n'),
    toc: headings,
    blocks: blockPayloads,
    editable: appState.editable,
    mode: appState.mode,
    lineCount: source.replace(/\r\n/g, '\n').split('\n').length,
  };
}

async function renderBlock(block, themeName) {
  const blockId = createHash('sha1').update(`${block.startLine}:${block.endLine}:${block.markdown}`).digest('hex').slice(0, 12);
  const renderedHtml = await renderMarkdownBlock(block, themeName, true);
  const previewHtml = await renderMarkdownBlock(block, themeName, false);
  const attrs = [
    `class="md-block md-block--${escapeHtml(block.type)}"`,
    `data-block-id="${blockId}"`,
    `data-start-line="${block.startLine}"`,
    `data-end-line="${block.endLine}"`,
    `data-block-type="${escapeHtml(block.type)}"`,
    `data-section="${escapeHtml(block.section || '')}"`,
    `data-markdown="${escapeHtml(block.markdown)}"`,
    `data-search-text="${escapeHtml(stripMarkdownForSearch(block.markdown))}"`,
  ];

  if (block.heading) {
    attrs.push(`data-heading-id="${escapeHtml(block.heading.slug)}"`);
    attrs.push(`data-heading-depth="${block.heading.depth}"`);
    attrs.push(`data-heading-text="${escapeHtml(block.heading.text)}"`);
  }

  return {
    id: blockId,
    previewHtml,
    shellHtml: `<section ${attrs.join(' ')}>${renderedHtml}</section>`,
  };
}

async function renderMarkdownBlock(block, themeName, withChrome) {
  if (block.type === 'code') {
    const { code, language } = parseCodeFence(block.markdown);
    const highlighted = await highlightCode(code, language, themeName);
    return withChrome
      ? `<div class="code-block" data-code-language="${escapeHtml(language || 'text')}">
          <button class="copy-code" type="button">Copy</button>
          ${highlighted}
        </div>`
      : `<div class="code-preview">${highlighted}</div>`;
  }

  const renderer = new marked.Renderer();
  renderer.heading = ({ tokens, depth }) => {
    const text = block.heading?.text ?? tokens.map((token) => token.raw || token.text || '').join('').trim();
    const slug = block.heading?.slug ?? slugify(text);
    return `<h${depth} id="${escapeHtml(slug)}">${escapeHtml(text)}</h${depth}>`;
  };

  return marked.parse(block.markdown, {
    gfm: true,
    breaks: false,
    renderer,
  });
}

async function highlightCode(code, language, themeName) {
  const cacheKey = `${themeName}:${language}:${code}`;
  if (highlighterCache.has(cacheKey)) {
    return highlighterCache.get(cacheKey);
  }

  const { codeToHtml, bundledLanguages, createHighlighter } = await getShiki();
  let html;

  if (bundledLanguages[language]) {
    html = await codeToHtml(code, { lang: language, theme: THEMES[themeName].shiki });
  } else {
    const highlighter = await createHighlighter({
      themes: [THEMES[themeName].shiki],
      langs: ['text'],
    });
    html = highlighter.codeToHtml(code, { lang: 'text', theme: THEMES[themeName].shiki });
  }

  highlighterCache.set(cacheKey, html);
  return html;
}

async function getShiki() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki');
  }
  return highlighterPromise;
}

function splitMarkdownBlocks(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index].trim() === '') {
      index += 1;
      continue;
    }

    const line = lines[index];
    const start = index;

    if (/^```|^~~~/.test(line)) {
      const fence = line.slice(0, 3);
      index += 1;
      while (index < lines.length && !lines[index].startsWith(fence)) {
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(makeBlock(lines, start, index, 'code'));
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      index += 1;
      blocks.push(makeBlock(lines, start, index, 'heading'));
      continue;
    }

    if (/^\s*([-*_]){3,}\s*$/.test(line)) {
      index += 1;
      blocks.push(makeBlock(lines, start, index, 'rule'));
      continue;
    }

    if (/^\s*>/.test(line)) {
      index = consumeWhile(lines, index, (value) => value.trim() === '' || /^\s*>/.test(value));
      blocks.push(makeBlock(lines, start, index, 'blockquote'));
      continue;
    }

    if (isListLine(line)) {
      index = consumeList(lines, index);
      blocks.push(makeBlock(lines, start, index, 'list'));
      continue;
    }

    if (isTableStart(lines, index)) {
      index = consumeWhile(lines, index, (value) => value.trim() !== '' && /^\s*\|/.test(value));
      blocks.push(makeBlock(lines, start, index, 'table'));
      continue;
    }

    index = consumeParagraph(lines, index);
    blocks.push(makeBlock(lines, start, index, 'paragraph'));
  }

  return blocks;
}

function makeBlock(lines, start, end, type) {
  return {
    type,
    startLine: start + 1,
    endLine: end,
    markdown: lines.slice(start, end).join('\n'),
  };
}

function consumeWhile(lines, start, predicate) {
  let index = start;
  while (index < lines.length && predicate(lines[index], index)) {
    index += 1;
  }
  return index;
}

function consumeParagraph(lines, start) {
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      break;
    }
    if (index !== start && isBlockBoundary(lines, index)) {
      break;
    }
    index += 1;
  }
  return index;
}

function consumeList(lines, start) {
  let index = start;
  let seenContent = false;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      const next = lines[index + 1];
      if (!next || !isContinuationLine(next)) {
        break;
      }
      index += 1;
      continue;
    }

    if (isListLine(line) || isContinuationLine(line)) {
      seenContent = true;
      index += 1;
      continue;
    }

    if (seenContent) {
      break;
    }
  }
  return index;
}

function isBlockBoundary(lines, index) {
  const line = lines[index];
  return (
    /^#{1,6}\s+/.test(line) ||
    /^```|^~~~/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-*_]){3,}\s*$/.test(line) ||
    isListLine(line) ||
    isTableStart(lines, index)
  );
}

function isContinuationLine(line) {
  return /^\s{2,}\S/.test(line) || /^\s*>/.test(line);
}

function isListLine(line) {
  return /^(\s*)([-*+]|\d+\.)\s+/.test(line) || /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line);
}

function isTableStart(lines, index) {
  const line = lines[index];
  const next = lines[index + 1];
  if (!line || !next) {
    return false;
  }
  return /^\s*\|/.test(line) && /^\s*\|?(\s*:?-+:?\s*\|)+\s*$/.test(next);
}

function parseCodeFence(markdown) {
  const lines = markdown.split('\n');
  const opener = lines[0] || '';
  const language = opener.replace(/^(```|~~~)/, '').trim().split(/\s+/)[0] || 'text';
  const code = lines.slice(1, lines.length - 1).join('\n');
  return { code, language };
}

function stripMarkdownForSearch(markdown) {
  return markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[*_~>#-]/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function writeMarkdownChange(filePath, payload) {
  const startLine = Number(payload.startLine);
  const endLine = Number(payload.endLine);
  const content = String(payload.content ?? '');

  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    throw new Error('Invalid line range.');
  }

  const current = await readFile(filePath, 'utf8');
  const lines = current.replace(/\r\n/g, '\n').split('\n');
  const deleteCount = Math.max(0, endLine - startLine + 1);
  const before = deleteCount > 0 ? lines.slice(startLine - 1, endLine).join('\n') : '';
  const insertion = content === '' ? [] : content.replace(/\r\n/g, '\n').split('\n');

  lines.splice(Math.max(0, startLine - 1), deleteCount, ...insertion);
  const next = lines.join('\n');
  await writeFile(filePath, next, 'utf8');

  let change = null;
  if (before !== content) {
    change = {
      id: payload.id ?? randomUUID(),
      type: before.trim().length === 0 && content.trim().length > 0 ? 'added' : 'edit',
      section: payload.section || path.basename(filePath),
      line: startLine,
      before,
      after: content,
      anchor: payload.anchor ?? null,
    };

    if (change.type === 'added') {
      change.content = content;
      delete change.before;
      delete change.after;
    }

    await appendFeedbackChange(filePath, change);
  }

  return { change };
}

function normalizeSlashes(value) {
  return value.split(path.sep).join('/');
}

function resolveTheme(requestedTheme, fallbackTheme) {
  return requestedTheme === 'light' || requestedTheme === 'dark' ? requestedTheme : fallbackTheme;
}

function countHeadingDepth(markdown) {
  const match = markdown.match(/^(#{1,6})\s+/);
  return match ? match[1].length : 1;
}

function uniqueSlug(text, slugCounts) {
  const base = slugify(text);
  const count = slugCounts.get(base) ?? 0;
  slugCounts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function slugify(text) {
  const normalized = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return normalized || 'section';
}

function serializeForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function listen(server, preferredPort) {
  return new Promise((resolve, reject) => {
    const attempt = (port) => {
      const onError = (error) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE' && port < preferredPort + 20) {
          attempt(port + 1);
          return;
        }
        reject(error);
      };

      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        resolve(address.port);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };

    attempt(preferredPort);
  });
}

function send(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendJson(response, statusCode, data) {
  send(response, statusCode, JSON.stringify(data), 'application/json; charset=utf-8');
}

function resolveInitialFile(targetPath, explicitServe) {
  const stats = safeStat(targetPath);
  if (!stats) {
    return null;
  }

  if (!stats.isDirectory()) {
    return targetPath;
  }

  const candidates = listMarkdownFiles(targetPath);
  if (candidates.length === 0) {
    return null;
  }

  const readme = candidates.find((entry) => path.basename(entry.absolute).toLowerCase() === 'readme.md');
  if (readme) {
    return readme.absolute;
  }

  if (!explicitServe && fs.existsSync(path.join(targetPath, 'README.md'))) {
    return path.join(targetPath, 'README.md');
  }

  return candidates[0].absolute;
}

function safeStat(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

function getResolvedDocumentPath(appState, requestedPath) {
  const candidate = requestedPath ? path.resolve(appState.rootDir, requestedPath) : appState.currentFile;
  ensureWithinRoot(appState.rootDir, candidate);
  if (!candidate.toLowerCase().endsWith('.md')) {
    throw new Error('Only markdown files are supported.');
  }
  const stats = safeStat(candidate);
  if (!stats || !stats.isFile()) {
    throw new Error(`File not found: ${candidate}`);
  }
  return candidate;
}

function ensureWithinRoot(rootDir, candidate) {
  const relative = path.relative(rootDir, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the current root.');
  }
}

export function listMarkdownFiles(rootDir) {
  const output = [];
  walkMarkdownFiles(rootDir, output, rootDir);
  output.sort((a, b) => a.relative.localeCompare(b.relative));
  return output;
}

function walkMarkdownFiles(currentDir, output, rootDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const absolute = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(absolute, output, rootDir);
      continue;
    }

    if (entry.isFile() && absolute.toLowerCase().endsWith('.md')) {
      output.push({
        absolute,
        relative: normalizeSlashes(path.relative(rootDir, absolute)),
        segments: normalizeSlashes(path.relative(rootDir, absolute)).split('/'),
        name: path.basename(absolute),
      });
    }
  }
}

export function getFeedbackPath(filePath) {
  return `${filePath}.feedback.json`;
}

export async function readDocument(filePath) {
  return readFile(filePath, 'utf8');
}

export async function readFeedbackDocument(filePath) {
  const feedbackPath = getFeedbackPath(filePath);

  try {
    const raw = await readFile(feedbackPath, 'utf8');
    const parsed = JSON.parse(raw);
    const normalized = normalizeFeedbackShape(parsed, filePath);
    if (normalized.__rewritten) {
      delete normalized.__rewritten;
      await writeFeedbackDocument(filePath, normalized);
    }
    return normalized;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return normalizeFeedbackShape({}, filePath);
    }
    throw error;
  }
}

async function writeFeedbackDocument(filePath, feedback) {
  const feedbackPath = getFeedbackPath(filePath);
  await mkdir(path.dirname(feedbackPath), { recursive: true });
  await writeFile(feedbackPath, `${JSON.stringify(feedback, null, 2)}\n`, 'utf8');
}

function normalizeFeedbackShape(feedback, filePath) {
  let rewritten = false;
  const changes = Array.isArray(feedback.changes) ? feedback.changes : [];
  const normalizedChanges = changes.map((change) => {
    if (!change || typeof change !== 'object') {
      rewritten = true;
      return { id: randomUUID(), type: 'comment', section: path.basename(filePath), comment: String(change ?? '') };
    }

    if (!change.id) {
      rewritten = true;
    }

    return {
      id: change.id ?? randomUUID(),
      ...change,
    };
  });

  const normalized = {
    file: feedback.file || path.basename(filePath),
    reviewedAt: feedback.reviewedAt ?? null,
    changes: normalizedChanges,
  };

  if (rewritten) {
    normalized.__rewritten = true;
  }

  return normalized;
}

export async function appendFeedbackChange(filePath, payload) {
  const feedback = await readFeedbackDocument(filePath);
  const change = {
    id: payload.id ?? randomUUID(),
    type: payload.type || 'comment',
    section: payload.section || path.basename(filePath),
    line: payload.line ?? null,
    before: payload.before,
    after: payload.after,
    comment: payload.comment,
    selectedText: payload.selectedText,
    content: payload.content,
    anchor: payload.anchor ?? null,
    createdAt: payload.createdAt ?? new Date().toISOString(),
  };

  const sanitized = Object.fromEntries(
    Object.entries(change).filter(([, value]) => value !== undefined),
  );

  feedback.changes.push(sanitized);
  await writeFeedbackDocument(filePath, feedback);
  return feedback;
}

export async function deleteFeedbackChange(filePath, id) {
  const feedback = await readFeedbackDocument(filePath);
  feedback.changes = feedback.changes.filter((change) => change.id !== id);
  await writeFeedbackDocument(filePath, feedback);
  return feedback;
}

export async function markFeedbackSubmitted(filePath) {
  const feedback = await readFeedbackDocument(filePath);
  feedback.reviewedAt = new Date().toISOString();
  await writeFeedbackDocument(filePath, feedback);
  return feedback;
}

function buildStyles() {
  return `
:root {
  color-scheme: dark;
  --bg: #091018;
  --bg-elevated: rgba(14, 20, 31, 0.92);
  --bg-muted: rgba(255, 255, 255, 0.045);
  --bg-panel: rgba(255, 255, 255, 0.03);
  --bg-code: #0d1724;
  --text: #ebf1fb;
  --text-muted: #9ba9bf;
  --line: rgba(148, 163, 184, 0.18);
  --line-strong: rgba(148, 163, 184, 0.34);
  --accent: #64b5a7;
  --accent-strong: #8fd9cc;
  --accent-warm: #ffc870;
  --danger: #ff8370;
  --success: #7fe0a0;
  --shadow: 0 24px 90px rgba(0, 0, 0, 0.35);
  --radius: 22px;
  --sidebar-width: 280px;
  --feedback-width: 340px;
}

html[data-theme="light"] {
  color-scheme: light;
  --bg: #f5f6f2;
  --bg-elevated: rgba(255, 252, 247, 0.95);
  --bg-muted: rgba(11, 19, 34, 0.045);
  --bg-panel: rgba(255, 255, 255, 0.84);
  --bg-code: #edf3f0;
  --text: #17202c;
  --text-muted: #5e6c7f;
  --line: rgba(22, 34, 52, 0.12);
  --line-strong: rgba(22, 34, 52, 0.2);
  --accent: #167765;
  --accent-strong: #0f6454;
  --accent-warm: #b86b00;
  --danger: #b24a3d;
  --success: #1f8a46;
  --shadow: 0 20px 70px rgba(59, 76, 91, 0.14);
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
  background:
    radial-gradient(circle at top left, rgba(100, 181, 167, 0.18), transparent 26%),
    radial-gradient(circle at top right, rgba(255, 200, 112, 0.12), transparent 18%),
    var(--bg);
  color: var(--text);
  font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
}

body {
  font-size: 17px;
  line-height: 1.75;
}

button,
input,
textarea {
  font: inherit;
}

.app-shell {
  min-height: 100vh;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  padding: 18px 26px;
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(18px);
  background: linear-gradient(180deg, rgba(8, 11, 18, 0.92), rgba(8, 11, 18, 0.78));
}

html[data-theme="light"] .topbar {
  background: linear-gradient(180deg, rgba(255, 252, 247, 0.96), rgba(255, 252, 247, 0.86));
}

.topbar__meta,
.topbar__actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.eyebrow,
.sidebar-label {
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.page-title {
  font-size: 24px;
  line-height: 1.1;
  font-weight: 700;
  letter-spacing: -0.04em;
}

.chip,
.sidebar-toggle,
.feedback-item__delete,
.floating-toolbar button,
.composer button,
.heading-reactions button {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--bg-muted);
  color: var(--text);
  border-radius: 999px;
  cursor: pointer;
  transition: 140ms ease;
}

.chip,
.heading-reactions button {
  padding: 10px 14px;
}

.chip:hover,
.sidebar-toggle:hover,
.feedback-item__delete:hover,
.floating-toolbar button:hover,
.composer button:hover,
.heading-reactions button:hover {
  border-color: var(--line-strong);
  background: rgba(100, 181, 167, 0.16);
}

.chip.accent {
  border-color: rgba(100, 181, 167, 0.4);
  background: rgba(100, 181, 167, 0.18);
}

.sidebar-toggle {
  display: none;
  width: 42px;
  height: 42px;
  padding: 0;
  border-radius: 14px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 4px;
}

.sidebar-toggle span {
  display: block;
  width: 18px;
  height: 2px;
  background: currentColor;
}

.layout {
  display: grid;
  grid-template-columns: minmax(240px, var(--sidebar-width)) minmax(0, 1fr) minmax(280px, var(--feedback-width));
  min-height: calc(100vh - 81px);
}

.sidebar,
.feedback-panel {
  position: sticky;
  top: 81px;
  align-self: start;
  height: calc(100vh - 81px);
  overflow: auto;
  padding: 24px 18px 40px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0.012));
}

.sidebar {
  border-right: 1px solid var(--line);
}

.feedback-panel {
  border-left: 1px solid var(--line);
}

.sidebar-section + .sidebar-section {
  margin-top: 24px;
}

.toc,
.file-tree,
.feedback-list {
  display: grid;
  gap: 8px;
}

.toc a,
.file-tree button {
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: var(--text-muted);
  text-decoration: none;
  text-align: left;
  padding: 8px 10px;
  cursor: pointer;
}

.toc a:hover,
.toc a.is-active,
.file-tree button:hover,
.file-tree button.is-active {
  background: rgba(100, 181, 167, 0.14);
  color: var(--text);
}

.toc a[data-depth="2"] {
  padding-left: 18px;
}

.toc a[data-depth="3"] {
  padding-left: 26px;
}

.toc a[data-depth="4"],
.toc a[data-depth="5"],
.toc a[data-depth="6"] {
  padding-left: 34px;
}

.viewer {
  min-width: 0;
  padding: 42px clamp(28px, 5vw, 74px) 84px;
}

.doc {
  box-sizing: border-box;
  width: 100%;
  max-width: none;
  min-height: calc(100vh - 180px);
  padding: clamp(36px, 5vw, 62px);
  border: 1px solid var(--line);
  border-radius: 32px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.022)),
    var(--bg-panel);
  box-shadow: var(--shadow);
}

.doc > :first-child {
  margin-top: 0;
}

.doc > :last-child {
  margin-bottom: 0;
}

.doc h1,
.doc h2,
.doc h3,
.doc h4,
.doc h5,
.doc h6 {
  scroll-margin-top: 110px;
  line-height: 1.12;
  letter-spacing: -0.04em;
  margin: 1.45em 0 0.5em;
}

.doc h1 {
  font-size: clamp(2.8rem, 5.5vw, 4rem);
}

.doc h2 {
  font-size: clamp(1.8rem, 3vw, 2.5rem);
  color: var(--accent-strong);
}

.doc h3 {
  font-size: clamp(1.35rem, 2.3vw, 1.7rem);
}

.md-block--heading[data-heading-depth="2"] h2,
.md-block--heading[data-heading-depth="3"] h3 {
  position: relative;
  padding-right: 116px;
}

.doc p,
.doc ul,
.doc ol,
.doc blockquote,
.doc pre,
.doc table,
.doc hr {
  margin: 1em 0;
}

.doc a {
  color: var(--accent-strong);
}

.doc strong {
  color: inherit;
}

.doc code,
.doc pre,
.ProseMirror code,
.ProseMirror pre {
  font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
}

.doc :not(pre) > code,
.search-result__preview :not(pre) > code,
.feedback-item__body :not(pre) > code {
  padding: 0.18em 0.42em;
  border-radius: 8px;
  background: var(--bg-code);
  border: 1px solid var(--line);
  font-size: 0.92em;
}

.doc ul,
.doc ol,
.ProseMirror ul,
.ProseMirror ol {
  padding-left: 1.4em;
}

.doc li + li,
.ProseMirror li + li {
  margin-top: 0.28em;
}

.doc blockquote,
.ProseMirror blockquote {
  padding: 0.8em 1.1em 0.8em 1.2em;
  border-left: 3px solid var(--accent);
  background: rgba(100, 181, 167, 0.08);
  border-radius: 0 16px 16px 0;
}

.doc hr,
.ProseMirror hr {
  border: 0;
  border-top: 1px solid var(--line);
}

.doc table,
.ProseMirror table,
.search-result__preview table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--line);
  border-radius: 18px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.02);
}

.doc th,
.doc td,
.ProseMirror th,
.ProseMirror td,
.search-result__preview th,
.search-result__preview td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
  text-align: left;
}

.doc thead th,
.ProseMirror thead th,
.search-result__preview thead th {
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.doc tbody tr:hover {
  background: rgba(100, 181, 167, 0.08);
}

.code-block,
.code-preview {
  position: relative;
}

.copy-code {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 2;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(7, 10, 16, 0.88);
  color: #e0e7f6;
}

.code-block pre,
.code-preview pre {
  margin: 0;
  overflow: auto;
  border-radius: 18px;
  border: 1px solid var(--line);
}

.md-block {
  position: relative;
  border-radius: 18px;
  padding: 6px 10px;
  margin: 0 -10px;
  transition: background 150ms ease, outline-color 150ms ease, opacity 150ms ease, transform 150ms ease;
}

.md-block:hover {
  background: rgba(255, 255, 255, 0.025);
}

.md-block.is-search-hit {
  outline: 1px solid rgba(100, 181, 167, 0.42);
  background: rgba(100, 181, 167, 0.08);
}

.md-block.is-flash {
  animation: flashBlock 1.1s ease;
}

@keyframes flashBlock {
  0% {
    background: rgba(255, 200, 112, 0.26);
  }

  100% {
    background: transparent;
  }
}

.heading-reactions {
  position: absolute;
  top: 50%;
  right: 0;
  display: flex;
  gap: 6px;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-50%);
  transition: opacity 0.2s;
}

h2:hover .heading-reactions,
h3:hover .heading-reactions {
  opacity: 1;
  pointer-events: auto;
}

.heading-reactions button {
  min-width: 36px;
  padding: 6px 8px;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1;
}

.heading-reactions button[data-feedback-type="approve"] {
  border-color: rgba(127, 224, 160, 0.4);
  background: rgba(127, 224, 160, 0.12);
  color: var(--success);
}

.heading-reactions button[data-feedback-type="reject"] {
  border-color: rgba(255, 131, 112, 0.4);
  background: rgba(255, 131, 112, 0.12);
  color: var(--danger);
}

.heading-reactions button[data-feedback-type="comment"] {
  border-color: rgba(100, 181, 167, 0.4);
  background: rgba(100, 181, 167, 0.12);
  color: var(--accent);
}

.editor-shell {
  border: 1px solid rgba(100, 181, 167, 0.42);
  border-radius: 22px;
  background: rgba(8, 13, 20, 0.94);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

html[data-theme="light"] .editor-shell {
  background: rgba(255, 255, 255, 0.96);
}

.editor-shell__toolbar {
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  font-family: "Avenir Next", "Segoe UI", sans-serif;
}

.editor-shell__hint {
  color: var(--text-muted);
  font-size: 13px;
}

.editor-host {
  padding: 16px 18px 18px;
}

.ProseMirror {
  outline: none;
  min-height: 72px;
}

.ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  float: left;
  color: var(--text-muted);
  pointer-events: none;
  height: 0;
}

.ProseMirror .tableWrapper {
  overflow-x: auto;
}

.ProseMirror-selectednode {
  outline: 2px solid rgba(100, 181, 167, 0.46);
}

.floating-toolbar {
  position: fixed;
  z-index: 80;
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  box-shadow: var(--shadow);
}

.floating-toolbar button {
  min-width: 38px;
  height: 38px;
  border-radius: 999px;
  padding: 0 12px;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
}

.floating-toolbar button[data-active="true"] {
  background: rgba(100, 181, 167, 0.22);
  border-color: rgba(100, 181, 167, 0.45);
}

.composer {
  position: fixed;
  z-index: 90;
  width: min(360px, calc(100vw - 24px));
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 20px;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  box-shadow: var(--shadow);
}

.composer textarea {
  width: 100%;
  min-height: 110px;
  resize: vertical;
  padding: 12px 14px;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: var(--bg-code);
  color: var(--text);
}

.composer__meta {
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  color: var(--text-muted);
  font-size: 13px;
}

.composer__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.composer button {
  padding: 10px 14px;
}

.slash-menu {
  position: fixed;
  z-index: 85;
  width: min(280px, calc(100vw - 24px));
  padding: 8px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  box-shadow: var(--shadow);
}

.slash-menu button {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  border-radius: 12px;
  padding: 10px 12px;
  cursor: pointer;
}

.slash-menu button:hover,
.slash-menu button.is-active {
  background: rgba(100, 181, 167, 0.14);
}

.slash-menu small {
  display: block;
  color: var(--text-muted);
}

.feedback-panel__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 8px;
}

.feedback-panel__title {
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.feedback-panel__count {
  min-width: 36px;
  text-align: center;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(100, 181, 167, 0.16);
  font-family: "Avenir Next", "Segoe UI", sans-serif;
}

.feedback-panel__meta {
  margin-bottom: 16px;
  color: var(--text-muted);
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  font-size: 14px;
}

.feedback-item {
  border: 1px solid var(--line);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.028);
  padding: 14px;
  cursor: pointer;
}

.feedback-item:hover {
  border-color: var(--line-strong);
}

.feedback-item__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.feedback-item__badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.feedback-item__delete {
  min-width: 34px;
  height: 34px;
  padding: 0;
}

.feedback-item__section {
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}

.feedback-item__body {
  color: var(--text);
  font-size: 15px;
  line-height: 1.6;
}

.feedback-empty {
  padding: 20px 0;
  color: var(--text-muted);
}

.search-palette.hidden {
  display: none;
}

.search-palette {
  position: fixed;
  inset: 0;
  z-index: 70;
}

.search-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(4, 7, 12, 0.58);
  backdrop-filter: blur(10px);
}

.search-dialog {
  position: relative;
  width: min(900px, calc(100vw - 24px));
  margin: 10vh auto 0;
  border-radius: 24px;
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.search-input-wrap {
  padding: 18px 20px;
  border-bottom: 1px solid var(--line);
}

.search-input-wrap input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 19px;
}

.search-results {
  max-height: 62vh;
  overflow: auto;
  padding: 10px;
}

.search-result {
  width: 100%;
  display: grid;
  gap: 8px;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: var(--text);
  text-align: left;
  padding: 14px;
  cursor: pointer;
}

.search-result:hover,
.search-result.is-selected {
  background: rgba(100, 181, 167, 0.12);
}

.search-result__header {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.search-result__preview {
  color: var(--text);
  max-height: 140px;
  overflow: hidden;
  mask-image: linear-gradient(180deg, #000 78%, transparent);
}

.search-result__preview > :first-child {
  margin-top: 0;
}

.search-result__preview > :last-child {
  margin-bottom: 0;
}

.status-toast {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 95;
  padding: 12px 14px;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  box-shadow: var(--shadow);
  font-family: "Avenir Next", "Segoe UI", sans-serif;
}

@media (max-width: 1320px) {
  .layout {
    grid-template-columns: minmax(240px, var(--sidebar-width)) minmax(0, 1fr);
  }

  .feedback-panel {
    position: fixed;
    right: 12px;
    top: 93px;
    width: min(var(--feedback-width), calc(100vw - 24px));
    height: calc(100vh - 105px);
    border: 1px solid var(--line);
    border-radius: 24px;
    background: rgba(12, 18, 28, 0.96);
    box-shadow: var(--shadow);
  }

  html[data-theme="light"] .feedback-panel {
    background: rgba(255, 252, 247, 0.98);
  }
}

@media (max-width: 980px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .sidebar-toggle {
    display: inline-flex;
  }

  .sidebar {
    position: fixed;
    inset: 81px auto 0 0;
    width: min(320px, calc(100vw - 36px));
    transform: translateX(-102%);
    transition: transform 160ms ease;
    z-index: 45;
    background: rgba(8, 11, 18, 0.96);
    box-shadow: 24px 0 80px rgba(0, 0, 0, 0.35);
  }

  html[data-theme="light"] .sidebar {
    background: rgba(255, 252, 247, 0.97);
  }

  .layout.sidebar-open .sidebar {
    transform: translateX(0);
  }

  .feedback-panel {
    position: static;
    width: auto;
    height: auto;
    border-left: 0;
    border-top: 1px solid var(--line);
    border-radius: 0;
    box-shadow: none;
  }

  .viewer {
    padding: 22px 14px 32px;
  }

  .doc {
    border-radius: 24px;
    padding: 26px 20px 34px;
  }

  .topbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .topbar__actions {
    flex-wrap: wrap;
  }
}

@media print {
  body {
    background: #fff;
    color: #111;
  }

  .topbar,
  .sidebar,
  .feedback-panel,
  .copy-code,
  .search-palette,
  .floating-toolbar,
  .composer,
  .slash-menu,
  .status-toast {
    display: none !important;
  }

  .layout {
    display: block;
  }

  .viewer {
    padding: 0;
  }

  .doc {
    max-width: none;
    min-height: auto;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
}
`;
}
