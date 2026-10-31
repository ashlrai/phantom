import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { orderKey, parseOrderCitations, readOrderTrace } from './order-trace.js';

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it.each([
  ["Serves Mason's Oct 31 00:13 order.", ['10-31 00:13']],
  ["Serves Mason's Oct 30 23:45 and 23:49 orders.", ['10-30 23:45', '10-30 23:49']],
  ["Serves Mason's Oct 30 23:49 and Oct 31 00:13 orders.", ['10-30 23:49', '10-31 00:13']],
  ["Serves Mason’s Jan 2 09:05 order. Serves Mason's Jan 2 09:05 order.", ['01-02 09:05']],
  ["Goal: Serves Mason's Dec 9 12:30 ET order. Feb 1 12:00 unrelated.", ['12-09 12:30']],
])('parses %s', (body, keys) => { expect(parseOrderCitations(body)).toEqual(keys); });
it('normalizes inbox keys and rejects invalid timestamps', () => {
  expect(orderKey('2026-10-31 00:13 ET')).toBe('10-31 00:13');
  expect(orderKey('2026-10-31 00:13')).toBe('10-31 00:13');
  expect(orderKey('bad')).toBeNull();
  expect(orderKey('2026-13-31 24:13')).toBeNull();
  expect(parseOrderCitations('Oct 31 00:13 without a citation')).toEqual([]);
});
async function fixture(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'order-trace-'));
  await mkdir(join(root, 'leader'));
  await writeFile(join(root, 'leader', 'MASON-INBOX.md'),
    '## 2026-10-31 00:13 ET (Mason, Fake console) PRIORITY P0\nDo work\n## 2026-10-30 23:49 ET (Mason, Fake console) PRIORITY P0\nOther work\n');
}
it('joins queued, launched and published jobs; refreshes cached bodies and newest publish', async () => {
  await fixture();
  await mkdir(join(root, 'queue', 'prompts'), { recursive: true });
  await mkdir(join(root, 'metrics'));
  const body = "Serves Mason's Oct 31 00:13 order.";
  await writeFile(join(root, 'queue', 'prompts', 'RQ-FAKE-QUEUED.md'), body);
  const prompt = join(root, 'RQ-FAKE-ACTIVE.prompt');
  await writeFile(prompt, body);
  await writeFile(join(root, 'RQ-FAKE-ACTIVE.launch'), 'launched RQ-FAKE-ACTIVE fake-lane pid 123 base fake');
  const published = { event: 'publish', job: 'RQ-FAKE-ACTIVE', url: 'https://example.invalid/pr/2', ts: '2026-10-31T10:00:00Z' };
  const metrics = join(root, 'metrics', 'jobs.jsonl');
  await writeFile(metrics, '');
  let trace = await readOrderTrace({ runsDir: root, now: () => 0 });
  expect(trace.orders.find(o => o.key === '10-31 00:13')?.jobs).toEqual(expect.arrayContaining([
    { id: 'RQ-FAKE-QUEUED', state: 'queued', lane: null, url: null },
    { id: 'RQ-FAKE-ACTIVE', state: 'launched', lane: 'fake-lane', url: null },
  ]));
  await writeFile(metrics, [published, { ...published, url: 'https://example.invalid/pr/1', ts: '2026-10-30T10:00:00Z' }].map(x => JSON.stringify(x)).join('\n'));
  trace = await readOrderTrace({ runsDir: root });
  expect(trace.sources).toEqual({ inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' });
  expect(trace.orders.find(o => o.key === '10-31 00:13')?.jobs).toContainEqual({ id: published.job, state: 'published', lane: 'fake-lane', url: published.url });
  expect(trace.orders.find(o => o.key === '10-30 23:49')?.jobs).toEqual([]);
  await writeFile(prompt, "Serves Mason's Oct 30 23:49 order.");
  await utimes(prompt, new Date(), new Date(Date.now() + 2000));
  trace = await readOrderTrace({ runsDir: root });
  expect(trace.orders.find(o => o.key === '10-30 23:49')?.jobs).toHaveLength(1);
});
it('preserves inbox orders without prompt or metrics directories', async () => {
  await fixture();
  const trace = await readOrderTrace({ runsDir: root });
  expect(trace.sources.publishes).toBe('missing');
  expect(trace.sources.prompts).toBe('missing');
  expect(trace.orders).toHaveLength(2);
  expect(trace.orders.every(o => o.jobs.length === 0)).toBe(true);
  const missing = await readOrderTrace({ runsDir: join(root, 'absent') });
  expect(missing.sources).toEqual({ inbox: 'missing', prompts: 'missing', publishes: 'missing' });
});
it('caps bodies by newest mtime and ignores citations past 16 KiB', async () => {
  await fixture();
  const old = join(root, 'RQ-FAKE-OLD.prompt');
  const newest = join(root, 'RQ-FAKE-NEW.prompt');
  await writeFile(old, "Serves Mason's Oct 31 00:13 order.");
  await utimes(old, new Date(0), new Date(0));
  await writeFile(newest, 'x'.repeat(16 * 1024) + "Serves Mason's Oct 31 00:13 order.");
  const trace = await readOrderTrace({ runsDir: root, maxBodies: 1 });
  expect(trace.sources.prompts).toBe('degraded');
  expect(trace.orders.every(o => o.jobs.length === 0)).toBe(true);
});
it('keeps all inbox entries and valid publishes alongside malformed metrics', async () => {
  await fixture();
  await writeFile(join(root, 'leader', 'MASON-INBOX.md'), Array.from({ length: 25 }, (_, i) =>
    `## 2026-10-31 00:${String(i).padStart(2, '0')} ET (Mason, Fake console) PRIORITY P0\nOrder\n`).join(''));
  await writeFile(join(root, 'RQ-FAKE-PUBLISH.prompt'), "Serves Mason's Oct 31 00:13 order.");
  await mkdir(join(root, 'metrics'));
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), 'bad json\n' + JSON.stringify({ event: 'publish', job: 'RQ-FAKE-PUBLISH', ts: '2026-10-31T00:00:00Z', url: 'https://example.invalid/pr/3' }));
  const trace = await readOrderTrace({ runsDir: root });
  expect(trace.orders).toHaveLength(25);
  expect(trace.sources.publishes).toBe('degraded');
  expect(trace.orders.find(o => o.key === '10-31 00:13')?.jobs[0]?.state).toBe('published');
});
