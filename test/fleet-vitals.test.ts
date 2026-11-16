import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLaunchVitals } from '../src/core/fleet/launch-vitals.js';

describe('launch vitals', () => {
  it.each(['over_host', 'over_owned', 'settling', 'pressure', 'admit'])('does not guess the undocumented %s controller schema', async reason => {
    const root = await mkdtemp(join(tmpdir(), 'vitals-'));
    try {
      await mkdir(join(root, 'queue'));
      await writeFile(join(root, 'queue/admission-ctl.json'), JSON.stringify({ reason }));
      await writeFile(join(root, 'queue/status.json'), JSON.stringify({ lanes: { claude: { running: 1, target: 8, queued: 3 } } }));
      expect(await readLaunchVitals(root)).toEqual({ reason: null, nextWindowSeconds: null, queued: 3, lanes: [{ lane: 'claude', running: 1, target: 8, queued: 3 }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('does not invent a queue total when a lane is missing its count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vitals-'));
    try {
      await mkdir(join(root, 'queue'));
      await writeFile(join(root, 'queue/status.json'), JSON.stringify({ lanes: { claude: { running: 0 } } }));
      expect((await readLaunchVitals(root)).queued).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
