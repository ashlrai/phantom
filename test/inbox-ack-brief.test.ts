import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { InboxAck } from '../src/core/fleet/inbox-ack.js';
import { buildPlannerBrief } from '../src/core/fleet/planner-brief.js';

it('acks exactly the tagged entries consumed by the real brief, once across reruns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inbox-brief-'));
  try {
    mkdirSync(join(root, 'leader'));
    writeFileSync(join(root, 'leader', 'MASON-INBOX.md'), [
      '2026-11-02T12:00:00Z [src:desktop id:first] desktop order',
      '2026-11-02T12:00:01Z [src:telegram id:second] telegram order',
    ].join('\n'));
    const desktop = vi.fn(async (_ack: InboxAck) => {}), telegram = vi.fn(async (_ack: InboxAck) => {});
    const opts = { runsRoot: root, now: Date.parse('2026-11-02T12:01:00Z'),
      inboxAckSenders: { desktop, telegram }, git: vi.fn((_p, _a, _o, cb) => cb(null, '')) };
    const brief = await buildPlannerBrief(opts);
    expect(brief.text).toContain('desktop order');
    expect(brief.text).toContain('telegram order');
    await buildPlannerBrief(opts);
    expect(desktop).toHaveBeenCalledTimes(1);
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(desktop.mock.calls[0]?.[0]).toMatchObject({ entryId: 'first', channel: 'desktop' });
    expect(telegram.mock.calls[0]?.[0]).toMatchObject({ entryId: 'second', channel: 'telegram' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('does not ack entries omitted by the brief budget or reduced to a heading', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inbox-budget-'));
  try {
    mkdirSync(join(root, 'leader'));
    writeFileSync(join(root, 'leader', 'MASON-INBOX.md'), [
      '2026-11-02T12:00:00Z [src:desktop id:oversize] oversized body\n' + 'x'.repeat(270_000),
      '2026-11-02T12:00:01Z [src:desktop id:older] ' + 'x'.repeat(140_000),
      '2026-11-02T12:00:02Z [src:desktop id:newest] ' + 'x'.repeat(140_000),
    ].join('\n'));
    const desktop = vi.fn(async (_ack: InboxAck) => {});
    const brief = await buildPlannerBrief({ runsRoot: root, inboxAckSenders: { desktop },
      git: (_p, _a, _o, cb) => cb(null, '') });
    expect(brief.text).toContain('order body omitted');
    expect(brief.text).toContain('1 older entry omitted');
    expect(desktop).toHaveBeenCalledTimes(1);
    expect(desktop.mock.calls[0]?.[0].entryId).toBe('newest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
