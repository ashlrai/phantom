import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLanes } from '../src/cli/lanes.js';

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('omits the original secret-named state fields and home path', async () => {
  root = await mkdtemp(join(tmpdir(), 'lane-5411-'));
  vi.stubEnv('HOME', root);
  const queue = join(root, '.ashlr-runs/queue');
  await mkdir(queue, { recursive: true });
  await writeFile(join(queue, 'status.json'), JSON.stringify({
    last_tick: '2026-11-11T12:00:00Z', paused: null, mem_free_pct: 55,
    schema: 'dispatchd.status.v1', operator_secret: 'PRIVATE-MARKER-9f8e7d',
    lanes: { 'alpha-lane': { running: 0, target: 1, queued: 0, held: true,
      held_reason: 'hold until /Users/someone/private/quota resets',
      api_token: 'PRIVATE-MARKER-9f8e7d', healthy: 'yes' } },
  }));
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdLanes(['--json'])).toBe(0);
  const text = out.mock.calls[0]![0] as string;
  const report = JSON.parse(text);
  expect(text).not.toContain('PRIVATE-MARKER-9f8e7d');
  expect(text).not.toContain('/Users/someone');
  expect(report.lanes[0].heldReason).not.toContain('/Users/someone');
  expect('healthy' in report.lanes[0]).toBe(false);
});
