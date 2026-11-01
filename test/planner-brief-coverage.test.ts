import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlannerBrief, type PlannerBriefGit } from '../src/core/fleet/planner-brief.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'brief-coverage-'));
  roots.push(root);
  await mkdir(join(root, 'leader/drop'), { recursive: true });
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'leader/ORCHESTRATION.md'), '# Orchestrate');
  return root;
}
const git: PlannerBriefGit = (_program, _args, _options, done) => done(null, 'bridge(test): merge\n');
const INGESTED = (root: string) => join(root, 'leader/drop/ingested.tsv');
const INBOX = (root: string) => join(root, 'leader/MASON-INBOX.md');
const entry = (minute: string, body: string, priority = 'P0') =>
  `## 2026-11-01 00:${minute} ET (Mason, terminal) PRIORITY ${priority}\n${body}\n`;
const inboxSection = (text: string): string => text.slice(text.indexOf('## MASON INBOX'));

it('keeps every distinct valid ingested id past the 300-row horizon, dedupes, and never echoes malformed cells', async () => {
  const root = await fixture();
  const rows = ['t\tRQ-PHX-EARLY01\twho\tlane\ttier\tfirst title'];
  for (let i = 0; i < 400; i++) rows.push(`t\tid${i}\twho\tlane\ttier\ttitle${i}`);
  rows.push('t\tid7\twho\tlane\ttier\tduplicate row');
  rows.push('t\tBAD ID\twho\tlane\ttier\t## INJECTED HEADING');
  rows.push('t\tok-id\twho\tlane\ttier\t## NOT A HEADING');
  rows.push('incomplete row');
  await writeFile(INGESTED(root), rows.join('\n'));
  const brief = await buildPlannerBrief({ runsRoot: root, git });
  expect(brief.sections.usedIds).toBe(402);
  const idLine = brief.text.split('\n').find(line => line.includes('RQ-PHX-EARLY01'))!;
  expect(idLine.split(' ')).toContain('id0');
  expect(idLine.split(' ').filter(cell => cell === 'id7')).toHaveLength(1);
  expect(idLine).not.toContain('BAD ID');
  expect(brief.text).not.toContain('INJECTED');
  expect(brief.text).not.toMatch(/^## NOT A HEADING/m);
  expect(brief.text).toContain('\nNOT A HEADING\n');
  expect(brief.text).toContain('(2 malformed ledger rows ignored)');
});

it('flags truncated ledger coverage while listing every id inside the read window', async () => {
  const root = await fixture();
  const rows: string[] = [];
  for (let i = 0; i < 22_000; i++) rows.push(`2026-11-01 00:00\tRQ-PHX-${String(i).padStart(6, '0')}AA\twho\tlane\ttier\t${'p'.repeat(400)}`);
  await writeFile(INGESTED(root), rows.join('\n'));
  const brief = await buildPlannerBrief({ runsRoot: root, git });
  expect(brief.text).toContain('(source truncated: ingested.tsv exceeds the 8 MiB read window');
  expect(brief.text).toContain('RQ-PHX-021999AA');
  expect(brief.text).not.toContain('RQ-PHX-000000AA');
  expect(brief.sections.usedIds).toBeGreaterThan(10_000);
  expect(brief.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
}, 30_000);

it('keeps a multiline order crossing the old 60-line boundary whole with its header', async () => {
  const root = await fixture();
  const body = Array.from({ length: 80 }, (_, i) => `order line ${i}`).join('\n');
  await writeFile(INBOX(root), entry('00', 'small old order') + entry('01', body, 'P1') + entry('02', 'newest small order'));
  const brief = await buildPlannerBrief({ runsRoot: root, git });
  const section = inboxSection(brief.text);
  expect(section).toContain('## 2026-11-01 00:01 ET (Mason, terminal) PRIORITY P1\norder line 0\n');
  expect(section).toContain('order line 79\n## 2026-11-01 00:02 ET');
  expect(section.indexOf('00:00 ET')).toBeLessThan(section.indexOf('00:01 ET'));
  expect(section.indexOf('00:01 ET')).toBeLessThan(section.indexOf('00:02 ET'));
  expect(brief.sections.inboxLines).toBe(85);
});

it('fills the inbox budget newest-first with an explicit omission notice', async () => {
  const root = await fixture();
  const big = 'x'.repeat(150 * 1024);
  await writeFile(INBOX(root), entry('00', 'oldest order') + entry('01', big) + entry('02', big, 'P1') + entry('03', 'newest small order'));
  const brief = await buildPlannerBrief({ runsRoot: root, git });
  const section = inboxSection(brief.text);
  expect(section).toContain('newest small order');
  expect(section).toContain('00:02 ET (Mason, terminal) PRIORITY P1');
  expect(section).toContain('00:00 ET');
  expect(section).not.toContain('00:01 ET');
  expect(section).toContain('(1 older entry omitted — over the 256 KiB inbox budget)');
  expect(brief.sections.inboxLines).toBe(7);
});

it('marks an individually oversized order explicitly but keeps its header and newer orders', async () => {
  const root = await fixture();
  await writeFile(INBOX(root), entry('00', 'y'.repeat(300 * 1024)) + entry('01', 'later small order'));
  const brief = await buildPlannerBrief({ runsRoot: root, git });
  const section = inboxSection(brief.text);
  expect(section).toContain('## 2026-11-01 00:00 ET (Mason, terminal) PRIORITY P0\n(order body omitted: entry is ');
  expect(section).toContain('later small order');
  expect(section).not.toContain('yyy');
  expect(section.indexOf('00:00 ET')).toBeLessThan(section.indexOf('00:01 ET'));
});

it('marks an inbox window that outgrew the read bound and still shows the newest complete order', async () => {
  const root = await fixture();
  const big = 'z'.repeat(200 * 1024);
  const parts: string[] = [];
  for (let i = 0; i < 45; i++) parts.push(`## 2026-11-01 00:${String(i).padStart(2, '0')} ET (Mason, terminal) PRIORITY P0\n${big}\n`);
  parts.push('## 2026-11-01 01:00 ET (Mason, terminal) PRIORITY P0\nfinal order survives\n');
  await writeFile(INBOX(root), parts.join(''));
  const brief = await buildPlannerBrief({ runsRoot: root, git });
  const section = inboxSection(brief.text);
  expect(section).toContain('(source truncated: MASON-INBOX.md exceeds the 8 MiB read window');
  expect(section).toContain('01:00 ET (Mason, terminal) PRIORITY P0\nfinal order survives');
}, 30_000);

it('marks unavailable sources and headingless content instead of showing partial coverage', async () => {
  const root = await fixture();
  await writeFile(INBOX(root), 'loose notes without headings\nmore notes\n');
  const brief = await buildPlannerBrief({ runsRoot: root, git });
  const section = inboxSection(brief.text);
  expect(section).toContain('(2 lines without a timestamped heading omitted — partial or foreign content)');
  expect(section).not.toContain('loose notes');
});

it('marks missing sources visibly in every affected section', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brief-coverage-'));
  roots.push(root);
  const brief = await buildPlannerBrief({ runsRoot: root, git });
  expect(brief.missing).toEqual(expect.arrayContaining(['leader/drop/ingested.tsv', 'leader/MASON-INBOX.md']));
  expect(brief.text).toContain('## USED IDS\n(unavailable: leader/drop/ingested.tsv missing)');
  expect(brief.text).toContain('## USED TITLES\n(unavailable: leader/drop/ingested.tsv missing)');
  expect(brief.text).toContain('## MASON INBOX (newest last)\n(unavailable: leader/MASON-INBOX.md missing)');
});

it('marks a healthy but empty inbox', async () => {
  const root = await fixture();
  await writeFile(INBOX(root), '');
  const brief = await buildPlannerBrief({ runsRoot: root, git });
  expect(inboxSection(brief.text)).toContain('(no entries)');
});
