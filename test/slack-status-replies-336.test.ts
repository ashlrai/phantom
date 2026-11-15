import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation } from '../src/core/agents/slack-journal.js';
import { buildSlackBridgeStatus } from '../src/core/agents/slack-status.js';

const CH = 'C0TESTCHAN1';
const THREAD = '1700000000.000100';
const SECOND = '1700000100.000100';
const NOW = new Date('2023-11-15T00:00:00Z');
const AT1 = '2023-11-14T22:13:20Z';
const AT2 = '2023-11-14T22:15:00Z';
const DIGEST = 'a'.repeat(64);
const CLIENT = '11111111-1111-1111-1111-111111111111';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'slack-replies-336-'));
  roots.push(dir);
  return { runsDir: join(dir, 'runs'), stateRoot: join(dir, 'state'), configPath: join(dir, 'agent-network.toml'), commsPath: join(dir, 'comms.toml') };
}
type Row = { channel: string; thread?: string; state: 'attempted' | 'sent'; ts?: string };
function writeStore(stateRoot: string, rows: Row[]): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const messages: Record<string, unknown> = {};
  rows.forEach((row, i) => {
    messages[String(i).padStart(64, '0')] = { digest: DIGEST, clientId: CLIENT, expiresAt: 9e12, ...row };
  });
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
}
function ingest(runsDir: string, at: string, messageTs: string, decision: 'ingested' | 'ignored' = 'ingested'): void {
  recordSlackObservation({ at, decision, channelId: CH, messageTs, threadTs: THREAD, ...(decision === 'ignored' ? { reason: 'untrusted-sender' } : {}) }, { runsDir });
}
const status = (p: ReturnType<typeof setup>) => buildSlackBridgeStatus({ ...p, now: () => NOW });

describe('slack status replies (336)', () => {
  it('binds one sent same-thread reply to the first of two requests', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    ingest(p.runsDir, AT2, SECOND);
    writeStore(p.stateRoot, [{ channel: CH, thread: THREAD, state: 'sent', ts: '1700000050.000100' }]);
    const { replies } = status(p);
    expect(replies).toMatchObject({ state: 'ok', answered: 1, unanswered: 1, oldestUnansweredAt: AT2, uncertainSends: 0 });
    expect(replies.unansweredSample).toEqual([{ channelId: CH, threadTs: THREAD, messageTs: SECOND, at: AT2 }]);
  });

  it('never treats an attempted receipt as an answer', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    writeStore(p.stateRoot, [{ channel: CH, thread: THREAD, state: 'attempted' }]);
    expect(status(p).replies).toMatchObject({ answered: 0, unanswered: 1, uncertainSends: 1 });
  });

  it('does not let a top-level sent post answer a thread', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    writeStore(p.stateRoot, [{ channel: CH, state: 'sent', ts: '1700000050.000100' }]);
    expect(status(p).replies).toMatchObject({ answered: 0, unanswered: 1 });
  });

  it('ignores non-ingested journal entries', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD, 'ignored');
    writeStore(p.stateRoot, []);
    expect(status(p).replies).toMatchObject({ state: 'ok', answered: 0, unanswered: 0, oldestUnansweredAt: null });
  });

  it('reports all ingested requests unanswered when the send store is missing', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    expect(status(p).replies).toMatchObject({ state: 'ok', answered: 0, unanswered: 1, oldestUnansweredAt: AT1 });
  });

  it('reports missing with zeros when both sources are missing', () => {
    const p = setup();
    expect(status(p).replies).toEqual({
      state: 'missing', answered: 0, unanswered: 0, oldestUnansweredAt: null,
      uncertainSends: 0, rejected: 0, futureDated: 0, unansweredSample: [],
    });
  });

  it('degrades on a corrupt store without throwing or leaking digest/clientId', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    mkdirSync(p.stateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(p.stateRoot, 'messages.json'), '{not json', { mode: 0o600 });
    const s = status(p);
    expect(s.replies).toMatchObject({ state: 'degraded', answered: 0, unanswered: 1 });
    expect(JSON.stringify(s)).not.toContain(DIGEST);
  });

  it('never exposes digest or clientId from a valid store, and degrades on malformed rows', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    writeStore(p.stateRoot, [
      { channel: CH, thread: THREAD, state: 'sent', ts: '1700000050.000100' },
      { channel: 'bogus', state: 'sent', ts: '1700000050.000100' },
    ]);
    const s = status(p);
    expect(s.replies).toMatchObject({ state: 'degraded', answered: 1 });
    const text = JSON.stringify(s);
    expect(text).not.toContain(DIGEST);
    expect(text).not.toContain(CLIENT);
  });
});
