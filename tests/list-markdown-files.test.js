import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { listMarkdownFiles } from '../src/mdview-core.js';
import { createTempWorkspace } from './helpers.js';

test('listMarkdownFiles finds nested markdown files and ignores hidden paths', async (t) => {
  const root = await createTempWorkspace(t, {
    'alpha.md': '# Alpha\n\nIntro text.\n',
    'nested/bravo.md': '## Bravo Heading\n\nNested body.\n',
    'with spaces/charlie delta.md': 'Plain text only.\n',
    'notes.txt': 'ignore me\n',
    '.hidden/secret.md': '# Secret\n',
    'node_modules/pkg/skip.md': '# Skip\n',
  });

  const files = listMarkdownFiles(root);

  assert.deepEqual(files.map((entry) => entry.relative), [
    'alpha.md',
    'nested/bravo.md',
    'with spaces/charlie delta.md',
  ]);
  assert.equal(files[0].title, 'Alpha');
  assert.equal(files[1].title, 'Bravo Heading');
  assert.equal(files[2].directory, 'with spaces');
  assert.equal(files[2].absolute, path.join(root, 'with spaces/charlie delta.md'));
});

test('listMarkdownFiles returns an empty array for an empty directory', async (t) => {
  const root = await createTempWorkspace(t, {});
  assert.deepEqual(listMarkdownFiles(root), []);
});
