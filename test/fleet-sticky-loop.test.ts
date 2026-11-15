import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStickyLoop, correlateStickyLoop } from '../src/cli/fleet-sticky-loop.js';

const now = new Date(2026, 10, 6, 12).getTime();
const drops = ['2026-11-06 08:00:00\tA\tdrop\told', '2026-11-06 10:30:00\tA\tdrop\tnew', '2026-11-06 11:00:00\tB\tdefer\tdeferred', '2026-11-06 11:30:00\tC\tdrop\tsame second', '2026-11-06 11:59:00\tA\tdrop\ttoo late'].join('\n');
const events = ['2026-11-06 09:00:00 READY_STICKY reinject A', '2026-11-06 10:00:00 READY_STICKY reinject A', '2026-11-06 11:00:00 READY_STICKY reinject A', '2026-11-06 11:15:00 READY_STICKY reinject B', '2026-11-06 11:30:00 READY_STICKY reinject C', '2026-11-06 12:01:00 READY_STICKY reinject A', 'bad READY_STICKY reinject A'].join('\n');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('fleet sticky-loop', () => {
  it('correlates windowed reinjections with prior drops and sticky membership', () => {
    expect(correlateStickyLoop(events, drops, '# comment\n A \n', now, 2)).toEqual([
      { id: 'A', reinjectCount: 2, lastDropTime: '2026-11-06 10:30:00', lastDropReason: 'new', inStickyFront: true },
      { id: 'C', reinjectCount: 1, lastDropTime: '2026-11-06 11:30:00', lastDropReason: 'same second', inStickyFront: false },
    ]);
  });
  it('reads the overridden root and returns JSON; fails closed when evidence is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sticky-loop-'));
    try {
      await mkdir(join(root, 'queue'));
      await Promise.all([writeFile(join(root, 'dispatch-events.log'), events), writeFile(join(root, 'queue/skipped-empty.tsv'), drops), writeFile(join(root, 'queue/STICKY_FRONT'), 'A\n')]);
      vi.stubEnv('ASHLR_RUNS_DIR', root); vi.spyOn(Date, 'now').mockReturnValue(now);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await cmdFleetStickyLoop(['--hours', '2', '--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0])).entries).toHaveLength(2);
      expect(await cmdFleetStickyLoop(['--hours', '0'])).toBe(2);
      await rm(join(root, 'queue/STICKY_FRONT'));
      expect(await cmdFleetStickyLoop(['--json'])).toBe(1);
      expect(error).toHaveBeenCalledWith('fleet sticky-loop: evidence unavailable');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
