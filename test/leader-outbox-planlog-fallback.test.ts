import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readOutboxEntries } from '../src/core/fleet/mason-outbox.js';

let runsDir: string;
const write = (name: string, text: string): Promise<void> => writeFile(join(runsDir, 'leader', name), text);
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'leader-planlog-'));
  await mkdir(join(runsDir, 'leader'));
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

it.each(['missing', 'empty'])('uses explicit plan-log reply lines when the outbox is %s', async state => {
  if (state === 'empty') await write('MASON-OUTBOX.md', '\n');
  const plan = '# Plan\r\n## 2026-11-05 12:00 ET\r\n- unrelated\r\n- MASON-OUTBOX: Later answer\r\n## 2026-11-04 09:00 ET (Leader)\r\n- Reply for Mason, to copy there: Earlier answer\r\ncontinuation excluded\r\n';
  await write('PLAN-LOG.md', plan);
  expect(await readOutboxEntries({ runsDir })).toEqual({ sourceState: 'healthy', entries: [
    { at: '2026-11-04 09:00', text: '- Reply for Mason, to copy there: Earlier answer' },
    { at: '2026-11-05 12:00', text: '- MASON-OUTBOX: Later answer' },
  ] });
  expect(await readFile(join(runsDir, 'leader', 'PLAN-LOG.md'), 'utf8')).toBe(plan);
});

it('keeps the outbox authoritative', async () => {
  await write('MASON-OUTBOX.md', '## 2026-11-05 09:00 ET\nCanonical answer');
  await write('PLAN-LOG.md', '## 2026-11-05 10:00 ET\n- MASON-OUTBOX: fallback');
  expect((await readOutboxEntries({ runsDir })).entries).toEqual([
    { at: '2026-11-05 09:00', text: 'Canonical answer\nET' },
  ]);
});

it('keeps at most the newest 20 replies and honours smaller limits', async () => {
  await write('PLAN-LOG.md', Array.from({ length: 25 }, (_, i) =>
    `## 2026-11-05 10:${String(i).padStart(2, '0')} ET\n- MASON-OUTBOX: ${i}`).join('\n'));
  const result = await readOutboxEntries({ runsDir, limit: 30 });
  expect(result.entries).toHaveLength(20);
  expect(result.entries[0]!.text).toBe('- MASON-OUTBOX: 5');
  expect(result.entries[19]!.text).toBe('- MASON-OUTBOX: 24');
  expect((await readOutboxEntries({ runsDir, limit: 1 })).entries).toEqual(result.entries.slice(-1));
  expect((await readOutboxEntries({ runsDir, limit: 0 })).entries).toEqual([]);
});

it('scrubs fallback text and resets time at an undated heading', async () => {
  const token = 'sk-' + 'FAKE'.repeat(8);
  await write('PLAN-LOG.md', `## 2026-11-05 ET\n- MASON-OUTBOX: ${token}\n## Notes\nReply for Mason, to copy there: undated`);
  const { entries } = await readOutboxEntries({ runsDir });
  expect(entries[0]).toEqual({ at: '', text: 'Reply for Mason, to copy there: undated' });
  expect(entries[1]!.at).toBe('2026-11-05');
  expect(entries[1]!.text).not.toContain(token);
  expect(entries[1]!.text).toContain('[REDACTED]');
});

it('handles absent, irrelevant and unreadable fallback sources', async () => {
  expect(await readOutboxEntries({ runsDir })).toEqual({ sourceState: 'missing', entries: [] });
  await write('MASON-OUTBOX.md', '');
  await write('PLAN-LOG.md', '## 2026-11-05 ET\n- ordinary planning');
  expect(await readOutboxEntries({ runsDir })).toEqual({ sourceState: 'healthy', entries: [] });
  await rm(join(runsDir, 'leader', 'PLAN-LOG.md'));
  await mkdir(join(runsDir, 'leader', 'PLAN-LOG.md'));
  expect(await readOutboxEntries({ runsDir })).toEqual({ sourceState: 'degraded', entries: [] });
});
