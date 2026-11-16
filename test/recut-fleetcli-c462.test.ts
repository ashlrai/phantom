import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderNotices } from '../src/cli/fleet-order-notices.js';
import type { OrderMergeNotice } from '../src/core/fleet/order-merge-notice.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Real on-disk fixture for the recut behavior: one inbox order whose single
 * job is cited by a prompt file, still queued on a lane held in slots.json.
 * 12:00Z is 07:00 in America/New_York, so the order key is '11-14 07:00'. */
function fixture(opts: { slots?: object | 'absent' } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'recut-fleetcli-c462-'));
  dirs.push(root);
  for (const path of ['leader', 'queue/prompts', 'metrics']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'leader', 'MASON-INBOX.md'),
    '2026-11-14T12:00:00.000Z [src:desktop id:fake-entry-1] Ship the plainly fake blocked fix\n');
  writeFileSync(join(root, 'queue/prompts/RQ-PHX-FAKEBLK1.md'), "Serve Mason's Nov 14 07:00 order");
  writeFileSync(join(root, 'queue', 'ready.tsv'), 'READY\tRQ-PHX-FAKEBLK1\tfake-held\n');
  if (opts.slots !== 'absent') {
    writeFileSync(join(root, 'queue', 'slots.json'), JSON.stringify(opts.slots ?? {
      'fake-held': { target: 0, floor: 0, ceiling: 2, held: true,
        held_until: '2026-11-20T00:00:00Z', held_reason: 'fake hold reason' },
    }));
  }
  return root;
}

describe('fleet order-notices blocked lanes (recut-c462)', () => {
  it('dry run plans one Blocked notice for a job queued on a held lane and writes nothing', async () => {
    const root = fixture();
    const lines: string[] = [];
    expect(await cmdFleetOrderNotices(['--runs-dir', root], { output: text => lines.push(text) })).toBe(0);
    expect(lines).toEqual([
      'desktop: Blocked: your 11-14 07:00 order waits on lane fake-held held until 2026-11-20T00:00:00.000Z.',
      'dry run: 1 notices; add --apply to send',
    ]);
    expect(existsSync(join(root, 'queue', 'order-notices.jsonl'))).toBe(false);
  });

  it('--apply sends once through the sender and the ledger key is terminal on a second run', async () => {
    const root = fixture();
    const send = vi.fn(async (_: OrderMergeNotice) => {});
    const lines: string[] = [];
    const deps = { senders: { desktop: send }, output: (text: string) => lines.push(text) };
    expect(await cmdFleetOrderNotices(['--runs-dir', root, '--apply', '--json'], deps)).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ sent: 1, skipped: 0, failed: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({
      channel: 'desktop', entryId: 'fake-entry-1', jobId: 'RQ-PHX-FAKEBLK1',
      text: 'Blocked: your 11-14 07:00 order waits on lane fake-held held until 2026-11-20T00:00:00.000Z.',
    });
    expect(readFileSync(join(root, 'queue', 'order-notices.jsonl'), 'utf8')).toContain('"status":"sent"');
    expect(await cmdFleetOrderNotices(['--runs-dir', root, '--apply', '--json'], deps)).toBe(0);
    expect(JSON.parse(lines[1]!)).toMatchObject({ sent: 0, skipped: 0, failed: 0, notices: [] });
    expect(send).toHaveBeenCalledOnce();
  });

  it('plans no blocked notice when the routed lane is not held', async () => {
    const root = fixture({ slots: {
      'fake-held': { target: 0, floor: 0, ceiling: 2, held: false, held_until: null, held_reason: null },
    } });
    const lines: string[] = [];
    expect(await cmdFleetOrderNotices(['--runs-dir', root, '--json'], { output: text => lines.push(text) })).toBe(0);
    expect(JSON.parse(lines[0]!).notices).toEqual([]);
  });

  it('a missing slots.json never fails the run: it exits 0 with no blocked notice', async () => {
    const root = fixture({ slots: 'absent' });
    const lines: string[] = [];
    expect(await cmdFleetOrderNotices(['--runs-dir', root, '--json'], { output: text => lines.push(text) })).toBe(0);
    expect(JSON.parse(lines[0]!).notices).toEqual([]);
  });
});
