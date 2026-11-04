import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetOrderNotices } from '../src/cli/fleet-order-notices.js';
import { appendInboxEntry } from '../src/core/fleet/mason-inbox.js';
import type { OrderMergeNotice } from '../src/core/fleet/order-merge-notice.js';

// Inbox line -> order trace -> merge notice -> channel sender, through the real modules.
// Only the merged-PR source (metrics/jobs.jsonl + job goal text) and the senders are fixtures.
let root: string;
const telegram = vi.fn(async (_: OrderMergeNotice) => {});
const email = vi.fn(async (_: OrderMergeNotice) => {});
// Same call the self-tick order-notices step makes: --json --apply --runs-dir.
const tick = async () => {
  const lines: string[] = [];
  const code = await cmdFleetOrderNotices(['--json', '--apply', '--runs-dir', root],
    { senders: { telegram, email }, output: t => lines.push(t), error: t => lines.push(t) });
  return { code, report: JSON.parse(lines.at(-1)!) as { sent: number; skipped: number; failed: number } };
};
const merge = async (job: string, goal: string, pr: number) => {
  await writeFile(join(root, 'queue', 'prompts', `${job}.md`), goal);
  await writeFile(join(root, 'metrics', 'jobs.jsonl'),
    `${JSON.stringify({ job, state: 'merged', url: `https://github.com/example/fake/pull/${pr}` })}\n`, { flag: 'a' });
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'order-notice-e2e-'));
  for (const dir of ['queue/prompts', 'metrics']) await mkdir(join(root, dir), { recursive: true });
  telegram.mockClear();
  email.mockClear();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('sends one same-channel notice per served order and never repeats it', async () => {
  // 2026-11-01T04:08Z is Nov 1 00:08 ET.
  const first = await appendInboxEntry('Fake order from telegram', { runsDir: root, source: 'telegram', now: () => new Date('2026-11-01T04:08:00Z') });
  expect(first).toMatchObject({ ok: true, at: '2026-11-01 00:08' });
  await merge('RQ-PHX-FAKEONE', "Goal: serves Mason's Nov 1 00:08 order.", 101);

  expect((await tick()).report).toMatchObject({ sent: 1, failed: 0 });
  expect(telegram).toHaveBeenCalledOnce();
  expect(email).not.toHaveBeenCalled();
  const notice = telegram.mock.calls[0]![0];
  expect(notice).toMatchObject({ channel: 'telegram', jobId: 'RQ-PHX-FAKEONE' });
  expect(notice.text).toContain('RQ-PHX-FAKEONE');
  expect(notice.text).toContain('/pull/101');

  expect((await tick()).report).toMatchObject({ sent: 0, failed: 0 });
  expect(telegram).toHaveBeenCalledOnce();
  expect(await readFile(join(root, 'queue', 'order-notices.jsonl'), 'utf8')).toContain('"status":"sent"');

  await appendInboxEntry('Fake order from email', { runsDir: root, source: 'email', now: () => new Date('2026-11-01T05:30:00Z') });
  await merge('RQ-PHX-FAKETWO', "Goal: serves Mason's Nov 1 01:30 order.", 102);

  expect((await tick()).report).toMatchObject({ sent: 1, failed: 0 });
  expect(email).toHaveBeenCalledOnce();
  expect(email.mock.calls[0]![0]).toMatchObject({ channel: 'email', jobId: 'RQ-PHX-FAKETWO' });
  expect(email.mock.calls[0]![0].text).toContain('/pull/102');
  expect(telegram).toHaveBeenCalledOnce();

  expect((await tick()).report).toMatchObject({ sent: 0, failed: 0 });
  expect(telegram).toHaveBeenCalledOnce();
  expect(email).toHaveBeenCalledOnce();
});
