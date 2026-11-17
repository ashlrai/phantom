import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSlackWorkStatus, slackFleetAsOf, slackWorkStatusLine, type SlackWorkStatus } from '../src/core/agents/slack-status.js';

const NOW = new Date('2026-11-06T12:00:00Z');
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function read(tick: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-as-of-527-'));
  roots.push(dir);
  const runsDir = join(dir, 'runs');
  if (tick !== null) {
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'queue/status.json'), JSON.stringify({ last_tick: tick }));
  }
  return readSlackWorkStatus({ runsDir, busRoot: join(dir, 'bus'), now: () => NOW });
}
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const row = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id, channelRef: 'slack:T0FAKETEAM:C0FAKECHAN:1.1', state, owner: null, claimReceipt: null, pr: null, head: null, dependency: null, ...extra,
}) as SlackWorkStatus['items'][number];

describe('slack reply as-of label (527)', () => {
  it('labels a fresh tick with its source and no stale marker', () => {
    const line = slackWorkStatusLine(read(ago(2 * 60_000)), {});
    expect(line).toBe('UNKNOWN; owner unknown; claim unknown; fleet as of 2026-11-06T11:58Z from fleet tick');
    expect(line).not.toContain('stale');
  });

  it('marks an old tick as stale background', () => {
    const line = slackWorkStatusLine(read(ago(3 * 3_600_000)), {});
    expect(line).toBe('UNKNOWN; owner unknown; claim unknown; fleet as of 2026-11-06T09:00Z from fleet tick (stale, background only)');
  });

  it('keeps the unknown form when status.json is missing', () => {
    expect(slackWorkStatusLine(read(null), {})).toMatch(/; fleet as of unknown$/);
  });

  it('never presents asOf as current without a read clock', () => {
    const work: SlackWorkStatus = { asOf: ago(60_000), inbox: 'ok', truncated: false, items: [] };
    expect(slackWorkStatusLine(work, {})).toMatch(/; fleet as of unknown from fleet tick$/);
    expect(slackFleetAsOf({ ...work, readAt: 'garbage' })).toBe('fleet as of unknown from fleet tick');
  });

  it('keeps VERIFIED, BLOCKED and RECEIVED detail ahead of the as-of part', () => {
    const work: SlackWorkStatus = { ...read(ago(60_000)), items: [
      row('RQ-V', 'VERIFIED', { pr: 12, head: 'abc123' }),
      row('RQ-B', 'BLOCKED', { dependency: 'RQ-DEP' }),
      row('RQ-R', 'RECEIVED', { owner: 'fake-owner', claimReceipt: 'rcpt-1' }),
    ] };
    const tail = '; fleet as of 2026-11-06T11:59Z from fleet tick';
    expect(slackWorkStatusLine(work, { inReplyTo: 'RQ-V' })).toBe(`VERIFIED; PR 12; head abc123${tail}`);
    expect(slackWorkStatusLine(work, { inReplyTo: 'RQ-B' })).toBe(`BLOCKED; dependency RQ-DEP${tail}`);
    expect(slackWorkStatusLine(work, { inReplyTo: 'RQ-R' })).toBe(`RECEIVED; owner fake-owner; claim rcpt-1${tail}`);
  });
});
