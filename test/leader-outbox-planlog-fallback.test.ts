import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    { at: '2026-11-04 09:00', text: 'Earlier answer\ncontinuation excluded' },
    { at: '2026-11-05 12:00', text: 'Later answer' },
  ] });
  expect(await readFile(join(runsDir, 'leader', 'PLAN-LOG.md'), 'utf8')).toBe(plan);
});

it('combines outbox and plan-log replies', async () => {
  await write('MASON-OUTBOX.md', '## 2026-11-05 09:00 ET\nCanonical answer');
  await write('PLAN-LOG.md', '## 2026-11-05 10:00 ET\n- MASON-OUTBOX: fallback');
  expect((await readOutboxEntries({ runsDir })).entries).toEqual([
    { at: '2026-11-05 09:00', text: 'Canonical answer\nET' },
    { at: '2026-11-05 10:00', text: 'fallback' },
  ]);
});

it('keeps at most the newest replies and honours smaller limits', async () => {
  await write('PLAN-LOG.md', Array.from({ length: 25 }, (_, i) =>
    `## 2026-11-05 10:${String(i).padStart(2, '0')} ET\n- MASON-OUTBOX: ${i}`).join('\n'));
  const result = await readOutboxEntries({ runsDir, limit: 30 });
  expect(result.entries).toHaveLength(25);
  expect(result.entries[0]!.text).toBe('0');
  expect(result.entries[24]!.text).toBe('24');
  expect((await readOutboxEntries({ runsDir, limit: 1 })).entries).toEqual(result.entries.slice(-1));
  expect((await readOutboxEntries({ runsDir, limit: 0 })).entries).toEqual([]);
});

it('scrubs fallback text and resets time at an undated heading', async () => {
  const token = 'sk-' + 'FAKE'.repeat(8);
  await write('PLAN-LOG.md', `## 2026-11-05 ET\n- MASON-OUTBOX: ${token}\n## Notes\nReply for Mason, to copy there: undated`);
  const { entries } = await readOutboxEntries({ runsDir });
  expect(entries[0]).toEqual({ at: '', text: 'undated' });
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

it('serves all four fixture replies through CLI, desktop and phone models without writing journals', async () => {
  const { vi } = await import('vitest');
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  const outbox = '## 2026-11-09T08:00:00Z\nOutbox answer';
  const plan = [1, 2, 3].map(i => `## 2026-11-09T0${i}:00:00Z\n### Reply for Mason\nAnswer ${i}\nSecond paragraph.\n### Planning\nPrivate planning excluded`).join('\n');
  await write('MASON-OUTBOX.md', outbox);
  await write('PLAN-LOG.md', plan);
  await chmod(join(runsDir, 'leader/MASON-OUTBOX.md'), 0o444);
  await chmod(join(runsDir, 'leader/PLAN-LOG.md'), 0o444);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const { runLeaderCli } = await import('../src/cli/leader.js');
    expect(await runLeaderCli(['thread', '--json'])).toBe(0);
    const { messages } = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(messages.map((m: { text: string }) => m.text)).toEqual(['Answer 1\nSecond paragraph.', 'Answer 2\nSecond paragraph.', 'Answer 3\nSecond paragraph.', 'Outbox answer']);
    const { entries } = await readOutboxEntries({ runsDir });
    const { mergeThread } = await import('../src/web-ui/routes/verse/leader-thread/thread-merge-model.js');
    const { leaderReplyRows } = await import('../src/web-ui/routes/verse/mobile/leader-replies-model.js');
    expect(mergeThread(messages, [], Date.now(), undefined, entries).lines).toHaveLength(4);
    expect(leaderReplyRows(entries, [], Date.now())).toHaveLength(4);
    expect(await readFile(join(runsDir, 'leader/MASON-OUTBOX.md'), 'utf8')).toBe(outbox);
    expect(await readFile(join(runsDir, 'leader/PLAN-LOG.md'), 'utf8')).toBe(plan);
  } finally { log.mockRestore(); vi.unstubAllEnvs(); }
}, 30_000);

it('deduplicates reply text across files and plan passes before applying the limit', async () => {
  await write('MASON-OUTBOX.md', '## 2026-11-09T01:00:00Z\nSame answer');
  await write('PLAN-LOG.md', '## 2026-11-09T02:00:00Z\n**Reply for Mason:** Same answer\n## 2026-11-09T03:00:00Z\nReply for Mason: New answer');
  expect((await readOutboxEntries({ runsDir })).entries.map(e => e.text)).toEqual(['Same answer', 'New answer']);
  expect((await readOutboxEntries({ runsDir, limit: 1 })).entries.map(e => e.text)).toEqual(['New answer']);
});

it('lists the latest reply per dated entry newest first through the replies CLI', async () => {
  const { vi } = await import('vitest');
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  await write('PLAN-LOG.md', [3, 1, 2].map(i => `## 2026-11-09 0${i}:00 ET\n**Reply for Mason**\nOld ${i}\n### Planning\nPrivate\n**Reply for Mason**\nAnswer ${i}`).join('\n'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const { runLeaderCli } = await import('../src/cli/leader.js');
    expect(await runLeaderCli(['replies', '--json', '--limit', '3'])).toBe(0);
    const result = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(result.entries.map((e: { at: string; text: string }) => [e.at, e.text])).toEqual([
      ['2026-11-09 03:00', 'Answer 3'], ['2026-11-09 02:00', 'Answer 2'], ['2026-11-09 01:00', 'Answer 1'],
    ]);
    expect((await readOutboxEntries({ runsDir })).entries.map(e => e.text)).toEqual(['Answer 1', 'Answer 2', 'Answer 3']);
    expect(await runLeaderCli(['replies', '--json', '--limit', '1'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0])).entries).toHaveLength(1);
  } finally { log.mockRestore(); vi.unstubAllEnvs(); }
}, 30_000);

it('keeps the newest duplicate reply and its timestamp on the CLI, desktop and phone', async () => {
  const { vi } = await import('vitest');
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  const fixture = '## 2026-11-09T01:00:00Z\n### Reply for Mason\nSame reply\n## 2026-11-09T02:00:00Z\n### Reply for Mason\nOther reply\n## 2026-11-09T03:00:00Z\n### Reply for Mason\nSame reply\n### Planning\nNot a reply';
  await write('PLAN-LOG.md', fixture);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const { runLeaderCli } = await import('../src/cli/leader.js');
    expect(await runLeaderCli(['replies', '--json'])).toBe(0);
    const result = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(result.entries.map((e: { at: string; text: string }) => [e.at, e.text])).toEqual([
      ['2026-11-09T03:00:00Z', 'Same reply'], ['2026-11-09T02:00:00Z', 'Other reply'],
    ]);
    const { entries } = await readOutboxEntries({ runsDir });
    const { leaderReplyRows } = await import('../src/web-ui/routes/verse/mobile/leader-replies-model.js');
    const { listLeaderThread } = await import('../src/core/vision/leader-thread.js');
    const desktop = (await listLeaderThread()).filter(m => m.text === 'Same reply');
    expect(desktop).toHaveLength(1);
    expect(desktop[0]).toMatchObject({ from: 'leader', at: '2026-11-09T03:00:00.000Z' });
    expect(leaderReplyRows(entries, [], Date.now()).filter(row => row.text === 'Same reply')).toMatchObject([
      { who: 'leader', at: '2026-11-09T03:00:00.000Z' },
    ]);
  } finally { log.mockRestore(); vi.unstubAllEnvs(); }
}, 30_000);


it('keeps the same reply on different dates while deduplicating a date', async () => {
  await write('MASON-OUTBOX.md', '## 2026-11-08T01:00:00Z\nSame answer');
  await write('PLAN-LOG.md', '## 2026-11-08T02:00:00Z\n**Reply for Mason:** Same answer\n## 2026-11-09T03:00:00Z\n**Reply for Mason:** Same answer');
  const { entries } = await readOutboxEntries({ runsDir });
  expect(entries.map(e => e.at)).toEqual(['2026-11-08T02:00:00Z', '2026-11-09T03:00:00Z']);
});

it('reads --file and PHANTOM_PLAN_LOG, skips entries without a reply, and explains a missing file', async () => {
  const { vi } = await import('vitest');
  const { join } = await import('node:path');
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  await write('custom.md', '## 2026-11-07 09:00 ET\n**Reply for Mason**\n> First\n## 2026-11-08 09:00 ET\nNo reply here\n## 2026-11-09 09:00 ET\n**Reply for Mason**\n> Third');
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const { runLeaderCli } = await import('../src/cli/leader.js');
    const file = join(runsDir, 'leader', 'custom.md');
    const texts = () => JSON.parse(String(log.mock.calls.at(-1)![0])).entries.map((e: { text: string }) => e.text);
    expect(await runLeaderCli(['replies', '--json', '--file', file])).toBe(0);
    expect(texts()).toEqual(['> Third', '> First']);
    vi.stubEnv('PHANTOM_PLAN_LOG', file);
    expect(await runLeaderCli(['replies', '--json'])).toBe(0);
    expect(texts()).toEqual(['> Third', '> First']);
    expect(await runLeaderCli(['replies', '--json', '--file', join(runsDir, 'nope.md')])).toBe(0);
    const missing = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(missing.entries).toEqual([]);
    expect(missing.reason).toMatch(/No PLAN-LOG file/);
  } finally { log.mockRestore(); vi.unstubAllEnvs(); }
}, 30_000);
