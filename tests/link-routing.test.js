import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { rewriteDocumentHref, toStaticRoute } from '../src/mdview-core.js';
import { createTempWorkspace } from './helpers.js';

test('toStaticRoute removes markdown extensions and preserves nesting', () => {
  assert.equal(toStaticRoute('guide.md'), 'guide/');
  assert.equal(toStaticRoute('nested/topic.md'), 'nested/topic/');
});

test('rewriteDocumentHref maps markdown links to static routes with base paths', async (t) => {
  const root = await createTempWorkspace(t, {
    'README.md': '# Home\n',
    'guide.md': '# Guide\n',
    'nested/topic.md': '# Topic\n',
  });

  const rootContext = {
    rootDir: root,
    mode: 'directory',
    runtime: 'static',
    filePath: path.join(root, 'README.md'),
    basePath: '/docs',
  };
  const nestedContext = {
    ...rootContext,
    filePath: path.join(root, 'nested/topic.md'),
  };

  assert.equal(rewriteDocumentHref('./guide.md', rootContext), '/docs/guide/');
  assert.equal(rewriteDocumentHref('./nested/topic.md#details', rootContext), '/docs/nested/topic/#details');
  assert.equal(rewriteDocumentHref('../README.md#top', nestedContext), '/docs/README/#top');
  assert.equal(rewriteDocumentHref('https://example.com', rootContext), 'https://example.com');
  assert.equal(rewriteDocumentHref('./asset.png', rootContext), './asset.png');
  assert.equal(rewriteDocumentHref('./missing.md', rootContext), './missing.md');
});
