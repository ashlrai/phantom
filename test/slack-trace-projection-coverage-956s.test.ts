import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { slackBridgeDir, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { fakeRequestId, replyKey, storeRow } from './helpers/slack-causal.js';

const now = new Date('2026-11-13T18:00:00Z');
const request = { at: '2026-11-13T17:30:00Z', decision: 'ingested', bus: 'posted',
  channelId: 'C0FAKE956S', threadTs: '1700000000.000100', messageTs: '1700000010.000100',
  authorId: 'U0FAKE956S', requestId: fakeRequestId('956s'), text: 'synthetic-private-body-956s' };
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(partial: boolean, damaged?: 'journal' | 'sends') {
  const root = mkdtempSync(join(tmpdir(), 'slack-956s-'));
  roots.push(root);
  const deps = { runsDir: join(root, 'runs'), stateRoot: join(root, 'state'), now: () => now, readClaims: () => [] };
  mkdirSync(slackBridgeDir(deps.runsDir), { recursive: true });
  mkdirSync(deps.stateRoot);
  // The oldest unanswered request falls outside the projection; ignored observations fill it.
  const padding = partial ? [{ ...request, requestId: fakeRequestId('omitted-956s') },
    ...Array.from({ length: 4095 }, () => ({ at: request.at, decision: 'ignored' }))] : [];
  writeFileSync(slackJournalPath(deps.runsDir), [...padding, request].map((row) => JSON.stringify(row) + '\n').join(''));
  if (damaged === 'journal') appendFileSync(slackJournalPath(deps.runsDir), 'synthetic-corrupt-row\n');
  writeFileSync(join(deps.stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages: {
    [replyKey(request.requestId)]: { ...storeRow({ channel: request.channelId, thread: request.threadTs,
      state: 'sent', ts: '1700000050.000100' }), text: request.text },
    ...(damaged === 'sends' ? { invalid: {} } : {}),
  } }));
  return deps;
}
async function run(args: string[], deps: ReturnType<typeof fixture>) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  log.mockClear();
  const code = await cmdFleetSlackTrace(args, deps);
  const out = log.mock.calls.map((call) => String(call[0])).join('\n');
  expect(err).not.toHaveBeenCalled();
  for (const value of [request.authorId, request.requestId, request.text, deps.runsDir, deps.stateRoot,
    'synthetic-corrupt-row', fakeRequestId('omitted-956s')]) expect(out).not.toContain(value);
  return { code, out };
}

it.each([
  [], ['--thread', request.threadTs], ['--channel', request.channelId],
  ['--thread', request.threadTs, '--channel', request.channelId, '--message', request.messageTs], ['--work-state'],
])('keeps projected answered evidence partial under selectors %j', async (...args) => {
  const deps = fixture(true);
  expect(readSlackRequestTrace(deps)).toMatchObject({ projectionOmitted: true,
    sources: { journal: 'ok', sends: 'ok' }, counts: { total: 1, answered: 1 } });
  const result = await run([...args, '--json'], deps);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out)).toMatchObject({ projectionOmitted: true,
    counts: { total: 1, answered: 1 }, rows: [{ outcome: 'answered', ingress: 'posted' }] });
});
it('warns explicitly in text while retaining the answered row', async () => {
  const result = await run([], fixture(true));
  expect(result.code).toBe(1);
  expect(result.out).toContain('Incomplete coverage: journal projection omitted observations');
  expect(result.out).toContain('counts cover returned rows only');
  expect(result.out).toContain('ANSWERED');
});
it('preserves successful complete readable evidence', async () => {
  const deps = fixture(false);
  const result = await run(['--json'], deps);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).not.toHaveProperty('projectionOmitted');
  expect(JSON.parse(result.out)).toMatchObject({
    sources: { journal: 'ok', sends: 'ok' }, counts: { total: 1, answered: 1 } });
  expect((await run([], deps)).out).not.toContain('Incomplete coverage');
});
it.each(['journal', 'sends'] as const)('retains degraded %s independently of projection coverage', async (source) => {
  for (const partial of [false, true]) {
    const result = await run(['--json'], fixture(partial, source));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).projectionOmitted).toBe(partial ? true : undefined);
    expect(JSON.parse(result.out)).toMatchObject({
      sources: { [source]: 'degraded' }, rows: [{ outcome: 'answered' }] });
  }
});
