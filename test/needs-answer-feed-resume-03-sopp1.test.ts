import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetNeedsAnswerFeed } from '../src/cli/fleet-needs-answer-feed.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { feedNeedsMasonAnswers, type AnswerFeedRecord } from '../src/core/fleet/needs-mason-answer-feed.js';
import { resolveNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

const texts = ['Pick fake blue', 'Pick fake green'];
const ids = texts.map(text => `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`);
let dir: string, bus: string, runs: string, file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feed-resume-')); bus = join(dir, 'bus'); runs = join(dir, 'runs'); file = join(dir, 'resume.json');
  mkdirSync(runs); writeFileSync(join(runs, 'NEEDS-MASON.md'), `# fake\n${texts.map(t => `- [ ] ${t}`).join('\n')}\n`);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const answer = (index: number) => resolveNeedsMason({ itemId: ids[index], reply: `fake reply ${index}` }, { runsDir: runs, bus: { root: bus } });
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
const args = () => [...ids, '--timeout-ms', '10', '--poll-ms', '5', '--bus-root', bus, '--json'];

it('resumes retained answers across invocations and completes without replay', async () => {
  expect(resolveFleetSubcommand('needs-answer-feed')).toEqual({ module: './fleet-needs-answer-feed.js', exportName: 'cmdFleetNeedsAnswerFeed' });
  expect(answer(0)).toMatchObject({ ok: true });
  const lines: string[] = [];
  expect(await cmdFleetNeedsAnswerFeed(args(), { ...clock(), emit: line => { lines.push(line); } })).toBe(3);
  const first = JSON.parse(lines[0]!);
  expect(first).toMatchObject({ type: 'answer', itemId: ids[0], checkpoint: { ids, delivered: [{ itemId: ids[0] }] } });
  expect(JSON.stringify(first.checkpoint)).not.toContain('fake reply');
  expect(JSON.parse(lines[1]!)).toMatchObject({ outcome: 'timeout', pending: [ids[1]] });
  writeFileSync(file, JSON.stringify(first.checkpoint));
  expect(answer(1)).toMatchObject({ ok: true });
  lines.length = 0;
  expect(await cmdFleetNeedsAnswerFeed([...args(), '--resume-file', file], { ...clock(), emit: line => { lines.push(line); } })).toBe(0);
  expect(lines.map(line => JSON.parse(line))).toMatchObject([{ type: 'answer', itemId: ids[1], checkpoint: { delivered: [{ itemId: ids[0] }, { itemId: ids[1] }] } }, { type: 'end', outcome: 'complete', pending: [] }]);
  writeFileSync(file, JSON.stringify(JSON.parse(lines[0]!).checkpoint));
  const read = vi.fn(); lines.length = 0;
  expect(await cmdFleetNeedsAnswerFeed([...args(), '--resume-file', file], { read, emit: line => { lines.push(line); } })).toBe(0);
  expect(read).not.toHaveBeenCalled(); expect(JSON.parse(lines[0]!).outcome).toBe('complete');
});

it('rejects malformed, oversized, mismatched and unreadable checkpoints before bus reads', async () => {
  answer(0); const records: AnswerFeedRecord[] = [];
  await feedNeedsMasonAnswers({ ids, root: bus, timeoutMs: 1 }, { ...clock(), emit: r => { records.push(r); } });
  const cp = (records[0] as Extract<AnswerFeedRecord, { type: 'answer' }>).checkpoint;
  const read = vi.fn();
  for (const input of ['{', 'x'.repeat(16385), JSON.stringify({ ...cp, root: 'bad' }), JSON.stringify({ ...cp, ids: [ids[0], 'nm-000000000000'] }), JSON.stringify({ ...cp, delivered: [{ ...cp.delivered[0], id: 'bad' }] })]) {
    writeFileSync(file, input);
    expect(await cmdFleetNeedsAnswerFeed([...args(), '--resume-file', file], { read })).toBe(2);
  }
  expect(await cmdFleetNeedsAnswerFeed([...args(), '--resume-file', join(dir, 'missing')], { read })).toBe(2);
  expect(read).not.toHaveBeenCalled();
});

it('does not advance after an emitter failure', async () => {
  answer(0); answer(1); const records: AnswerFeedRecord[] = [];
  const result = await feedNeedsMasonAnswers({ ids, root: bus, timeoutMs: 10 }, { ...clock(), emit: r => {
    if (r.type === 'answer' && r.itemId === ids[1]) throw new Error('fake failure');
    records.push(r);
  } });
  expect(result).toEqual({ outcome: 'unavailable', pending: [ids[1]] });
  const first = records[0] as Extract<AnswerFeedRecord, { type: 'answer' }>;
  expect(first.checkpoint.delivered).toHaveLength(1);
  writeFileSync(file, JSON.stringify(first.checkpoint)); records.length = 0;
  expect(await feedNeedsMasonAnswers({ ids, root: bus, timeoutMs: 10, resumeFile: file }, { emit: r => { records.push(r); } })).toMatchObject({ outcome: 'complete' });
  expect(records[0]).toMatchObject({ type: 'answer', itemId: ids[1] });
});

it('cancels pending work and removes signal listeners', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], lines: string[] = [];
  expect(await cmdFleetNeedsAnswerFeed(args(), { sleep: async () => { process.emit('SIGINT'); }, emit: line => { lines.push(line); } })).toBe(130);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'cancelled', pending: ids });
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
});
