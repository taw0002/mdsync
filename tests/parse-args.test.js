import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILD_COMMAND, DEFAULT_PORT, parseArgs } from '../src/mdview-core.js';

test('parseArgs defaults to view mode for a bare target path', () => {
  assert.deepEqual(parseArgs(['README.md', '--light', '--no-open']), {
    command: 'view',
    target: 'README.md',
    port: DEFAULT_PORT,
    light: true,
    noEdit: false,
    noOpen: true,
    out: undefined,
    title: undefined,
    base: '/',
    theme: 'auto',
  });
});

test('parseArgs preserves build flags and target', () => {
  assert.deepEqual(parseArgs([BUILD_COMMAND, './docs', '--out', './site', '--title', 'My Docs', '--base', '/docs', '--theme', 'light']), {
    command: BUILD_COMMAND,
    target: './docs',
    port: DEFAULT_PORT,
    light: false,
    noEdit: false,
    noOpen: false,
    out: './site',
    title: 'My Docs',
    base: '/docs',
    theme: 'light',
  });
});

test('parseArgs returns usage state for help', () => {
  assert.deepEqual(parseArgs(['--help']), {
    command: null,
    target: undefined,
    port: DEFAULT_PORT,
    light: false,
    noEdit: false,
    noOpen: false,
    out: undefined,
    title: undefined,
    base: '/',
    theme: 'auto',
  });
});
