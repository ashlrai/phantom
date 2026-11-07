import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlannerBrief, type PlannerBriefGit } from '../src/core/fleet/planner-brief.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git: PlannerBriefGit = (_program, _args, _options, done) => done(null, '');
const heading = '## 2026-11-01 23:38 ET (from Mason t1272u, relayed by Masbot)';
const channel = '2026-11-02T00:27:30-0500 [src:page id:masbot-install] install check from Masbot';
async function brief(inbox: string) {
  const root = await mkdtemp(join(tmpdir(), 'brief-channel-line-02-'));
  roots.push(root);
  await mkdir(join(root, 'leader'), { recursive: true });
  await writeFile(join(root, 'leader/MASON-INBOX.md'), inbox);
  const result = await buildPlannerBrief({ runsRoot: root, git });
  return result.text.slice(result.text.indexOf('## MASON INBOX'));
}

it('renders a channel entry after the existing order without changing its body', async () => {
  const body = 'original order body\nsecond body line';
  const section = await brief(`${heading}\n${body}\n${channel}\nchannel follow-up`);
  expect(section).toContain(`${heading}\n${body}\n${channel}\nchannel follow-up`);
  expect(section).not.toContain('without a timestamped heading');
  // Independent entry boundaries also preserve the older body when the new body is oversized.
  const oversized = await brief(`${heading}\n${body}\n${channel}\n${'x'.repeat(300 * 1024)}`);
  expect(oversized).toContain(`${heading}\n${body}\n${channel}\n(order body omitted:`);
});

it('keeps the newest channel entry while omitting older orders over budget', async () => {
  const big = 'x'.repeat(150 * 1024);
  const section = await brief(`${heading}\n${big}\n## 2026-11-01 23:39 ET (Mason)\n${big}\n${channel}`);
  expect(section).toContain(channel);
  expect(section).toContain('23:39 ET (Mason)');
  expect(section).not.toContain(heading);
  expect(section).toContain('(1 older entry omitted — over the 256 KiB inbox budget)');
});

it('keeps mid-line tags and untagged dates in the existing body', async () => {
  const body = 'body contains [src:page id:x] mid-line\n2026-11-02T00:27:30-0500 no tag';
  const section = await brief(`${heading}\n${body}`);
  expect(section).toContain(`${heading}\n${body}`);
  const fragments = await brief(`${body}\n${channel}`);
  expect(fragments).toContain('(2 lines without a timestamped heading omitted');
  expect(fragments).not.toContain(body);
});

it('opens a channel entry before any Markdown heading and counts only preceding fragments', async () => {
  const section = await brief(`loose fragment\n${channel}\nchannel body\n${heading}\nolder body`);
  expect(section).toContain('(1 line without a timestamped heading omitted');
  expect(section).toContain(`${channel}\nchannel body\n${heading}\nolder body`);
});

it('does not open an entry for a month-13 timestamp', async () => {
  const invalid = '2026-13-02T00:27:30-0500 [src:page id:x] invalid date';
  const section = await brief(`${invalid}\n${channel}`);
  expect(section).toContain('(1 line without a timestamped heading omitted');
  expect(section).not.toContain(invalid);
  expect(section).toContain(channel);
});
