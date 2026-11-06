import { nodeFixtureHeader } from './helpers/node-fixture.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryStaging, measureStaging } from '../src/core/fleet/staging-inventory.js';

const originalPath = process.env.PATH;
const trees: string[] = [];
async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'staging-responsive-'));
  trees.push(root);
  return root;
}
afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(trees.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForFile(path: string) {
  for (let i = 0; i < 500; i++) {
    try { return await readFile(path, 'utf8'); } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`fixture did not produce ${path}`);
}

describe('responsive staging inventory', () => {
  it('keeps the event loop responsive and waits for each real child process to exit', async () => {
    const root = await tree();
    const bin = join(root, 'bin'); await mkdir(bin);
    const started = join(root, 'started'); const release = join(root, 'release');
    const script = `${nodeFixtureHeader()}const fs = require('node:fs');\nconst [started, release] = ${JSON.stringify([started, release])};\nfs.appendFileSync(started, process.pid + '\\n');\nconst timer = setInterval(() => { if (fs.existsSync(release)) { clearInterval(timer); console.log('2\\tfixture'); } }, 10);\n`;
    await writeFile(join(bin, 'du'), script, { mode: 0o755 });
    process.env.PATH = bin;
    const listing = { state: 'ok' as const, children: ['a', 'b'].map((name) => ({ name, modifiedAt: '2026-01-01' })), skippedSymlinks: 0, truncated: false };
    const pending = inventoryStaging('/fake', { list: async () => listing });
    try {
      const first = Number((await waitForFile(started)).trim());
      let timerRan = false;
      await new Promise<void>((resolve) => setTimeout(() => { timerRan = true; resolve(); }, 0));
      expect(timerRan).toBe(true);
      expect((await readFile(started, 'utf8')).trim().split('\n')).toHaveLength(1);
      await writeFile(release, 'go');
      const report = await pending;
      const pids = (await readFile(started, 'utf8')).trim().split('\n').map(Number);
      expect(pids).toHaveLength(2); expect(pids[0]).toBe(first);
      expect(report.complete).toBe(true);
      expect(report.entries.map((entry) => entry.bytes)).toEqual([2048, 2048]);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await writeFile(release, 'go');
      await pending;
    }
  });

  it('reports subprocess failures as incomplete and null bytes', async () => {
    const root = await tree(); const bin = join(root, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'du'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = bin;
    const report = await inventoryStaging('/fake', { list: async () => ({ state: 'ok', children: [{ name: 'a', modifiedAt: 'x' }], skippedSymlinks: 0, truncated: false }) });
    expect(report.complete).toBe(false); expect(report.source).toBe('degraded');
    expect(report.entries[0]?.bytes).toBeNull(); expect(report.totalMeasuredBytes).toBe(0);
  });

  it('measures a synthetic filesystem and preserves the synchronous API', async () => {
    const root = await tree(); await mkdir(join(root, 'child'));
    await writeFile(join(root, 'child', 'data'), 'synthetic');
    await symlink(join(root, 'child'), join(root, 'link'));
    const report = await inventoryStaging(root, { now: 0 });
    expect(report.complete).toBe(true); expect(report.source).toBe('ok');
    expect(report.skippedSymlinks).toBe(1); expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.name).toBe('child');
    expect(report.entries[0]?.bytes).toBe(measureStaging(join(root, 'child')));
    expect(report.totalMeasuredBytes).toBe(report.entries[0]?.bytes);
  });
});
