import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function createTempWorkspace(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mdsync-test-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    if (content === null) {
      await mkdir(absolutePath, { recursive: true });
      continue;
    }
    await writeFile(absolutePath, content, 'utf8');
  }

  return root;
}

export async function readText(filePath) {
  return readFile(filePath, 'utf8');
}
