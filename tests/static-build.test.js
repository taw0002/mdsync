import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { startStaticBuild } from '../src/mdview-core.js';
import { createTempWorkspace, readText } from './helpers.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
const execFile = promisify(execFileCallback);

test('startStaticBuild writes a static site with clean URLs and rewritten links', async (t) => {
  const docsDir = await createTempWorkspace(t, {
    'README.md': '# Welcome\n\nSee the [Guide](guide.md), [Nested Topic](nested/topic.md#details), and [Spaced File](<with spaces/file name.md>).\n',
    'guide.md': '# Guide\n\nBack to [Welcome](README.md).\n',
    'nested/topic.md': '# Topic\n\n## Details\n\nSee the [Guide](../guide.md).\n',
    'with spaces/file name.md': '# Spaced File\n\nHello.\n',
  });
  const outDir = path.join(docsDir, 'site-output');

  const result = await startStaticBuild({
    command: 'build',
    target: docsDir,
    out: outDir,
    title: 'Published Docs',
    base: '/docs',
    theme: 'light',
  });

  assert.equal(result.documentCount, 4);

  await access(path.join(outDir, 'index.html'));
  await access(path.join(outDir, 'README/index.html'));
  await access(path.join(outDir, 'guide/index.html'));
  await access(path.join(outDir, 'nested/topic/index.html'));
  await access(path.join(outDir, 'with spaces/file name/index.html'));

  const indexHtml = await readText(path.join(outDir, 'index.html'));
  const readmeHtml = await readText(path.join(outDir, 'README/index.html'));

  assert.match(indexHtml, /Published Docs/);
  assert.match(indexHtml, /"staticBasePath":"\/docs"/);
  assert.match(indexHtml, /"relative":"guide\.md"/);
  assert.match(indexHtml, /"relative":"with spaces\/file name\.md"/);

  assert.match(readmeHtml, /href="\/docs\/guide\/"/);
  assert.match(readmeHtml, /href="\/docs\/nested\/topic\/#details"/);
  assert.match(readmeHtml, /href="\/docs\/with(?:%20| )spaces\/file(?:%20| )name\/"/);
  assert.match(readmeHtml, /"runtime":"static"/);
  assert.match(readmeHtml, /"staticDocThemes":\{"dark":/);
});

test('startStaticBuild supports empty directories', async (t) => {
  const docsDir = await createTempWorkspace(t, {});
  const outDir = path.join(docsDir, 'site-output');

  const result = await startStaticBuild({
    command: 'build',
    target: docsDir,
    out: outDir,
    title: 'Empty Docs',
    base: '/',
    theme: 'auto',
  });

  assert.equal(result.documentCount, 0);
  assert.equal(result.writtenFiles.length, 1);
  assert.match(await readText(path.join(outDir, 'index.html')), /Empty Docs/);
});

test('startStaticBuild validates the target and output arguments', async (t) => {
  const docsDir = await createTempWorkspace(t, {
    'README.md': '# Welcome\n',
  });
  const fileTarget = path.join(docsDir, 'README.md');

  await assert.rejects(
    () => startStaticBuild({ command: 'build', target: docsDir }),
    /--out/,
  );

  await assert.rejects(
    () => startStaticBuild({ command: 'build', target: fileTarget, out: path.join(docsDir, 'site-output') }),
    /directory target/,
  );
});

test('cli routes the build command end to end', async (t) => {
  const docsDir = await createTempWorkspace(t, {
    'guide.md': '# Guide\n\n[Self](guide.md)\n',
  });
  const outDir = path.join(docsDir, 'site-output');

  const { stdout, stderr } = await execFile(process.execPath, [
    cliPath,
    'build',
    docsDir,
    '--out',
    outDir,
    '--title',
    'CLI Docs',
    '--base',
    '/cli',
    '--theme',
    'dark',
  ], {
    cwd: path.dirname(cliPath),
  });

  assert.equal(stderr, '');
  assert.match(stdout, /Built 1 markdown file into/);
  assert.match(await readText(path.join(outDir, 'index.html')), /CLI Docs/);
  assert.match(await readText(path.join(outDir, 'guide/index.html')), /href="\/cli\/guide\/"/);
});
