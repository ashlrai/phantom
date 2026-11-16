import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlannerBrief } from '../src/core/fleet/planner-brief.js';
import type { InboxAck } from '../src/core/fleet/inbox-ack.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('omits status asks from orders and preserves acknowledgements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brief-status-')); roots.push(root);
  await mkdir(join(root, 'leader'), { recursive: true });
  const order = '2026-11-06T14:00:00.000Z [src:slack id:order-1] Ship the fix';
  const heading = `## 2026-11-06 10:36 ET (Operator, slack) PRIORITY P0 [leader-network:${'a'.repeat(64)}]`;
  const channel = '2026-11-06T23:01:00.000Z [src:slack id:slack-0123456789abcdef] status?';
  await writeFile(join(root, 'leader/MASON-INBOX.md'), `${order}\n${heading}\nPhantom status\n${channel}\n`);
  const slack = vi.fn(async (_ack: InboxAck) => {});
  const brief = await buildPlannerBrief({ runsRoot: root, inboxAckSenders: { slack }, git: (_p, _a, _o, cb) => cb(null, '') });
  expect(brief.text).toContain(order);
  expect(brief.text).not.toContain(heading);
  expect(brief.text).not.toContain(channel);
  expect(brief.text).not.toContain('Phantom status');
  expect(brief.text).toContain('(2 status ask(s) omitted; the channel auto-answers them: 2026-11-06 18:01 ET)');
  expect(slack).toHaveBeenCalledTimes(2);
  const rows = (await readFile(join(root, 'queue/inbox-acks.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(rows).toHaveLength(3);
  expect(rows.filter(row => row.status === 'skipped')).toHaveLength(1);
});

it('retains status text with continuation orders and excludes asks from the budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brief-status-')); roots.push(root);
  await mkdir(join(root, 'leader'), { recursive: true });
  const order = `2026-11-06T23:01:00Z [src:slack id:order] status?\nship the fix ${'x'.repeat(260_000)}`;
  const asks = Array.from({ length: 100 }, (_, i) => `2026-11-06T23:01:00Z [src:slack id:ask-${i}] status?`).join('\n');
  await writeFile(join(root, 'leader/MASON-INBOX.md'), `${order}\n${asks}`);
  const brief = await buildPlannerBrief({ runsRoot: root, inboxAckSenders: {}, git: (_p, _a, _o, cb) => cb(null, '') });
  expect(brief.text).toContain(order);
  expect(brief.text).toContain('100 status ask(s) omitted');
  expect(brief.text).not.toContain('over the 256 KiB inbox budget');
});
