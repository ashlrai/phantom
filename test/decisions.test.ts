/** `phm decisions`: the pure reply fold (foldDecisions) on plain fixtures, and the thin CLI over it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DECISIONS_SCHEMA, DECISIONS_VERSION, foldDecisions, parseDecisionReply,
  type DecisionRecord, type DecisionReply, type DecisionsReport,
} from '../src/core/fleet/approvals.js';
import { cmdDecisions } from '../src/cli/approvals.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const VERIFIED = { verifiedSenderIds: ['mason', 'mason-phone'], now: NOW };
const pay: DecisionRecord = { id: 'nm-3f2a00000001', code: '3f2a', kind: 'payment', question: 'Pay the team plan this month', asked_at: '2026-11-18T10:00:00.000Z', source: 'claude' };
const device: DecisionRecord = { id: 'nm-9c1d00000002', code: '9c1d', kind: 'device', question: 'Approve the new laptop sign-in', asked_at: '2026-11-18T10:30:00.000Z', source: 'codex' };
const reply = (text: string, sender = 'mason-phone', at = '2026-11-18T11:00:00.000Z', channel = 'telegram'): DecisionReply => ({ channel, sender_id: sender, text, at });

describe('foldDecisions', () => {
  it('empty input: nothing waiting, nothing ignored, with schema and version', () => {
    expect(foldDecisions([], [], VERIFIED)).toEqual({
      schema: DECISIONS_SCHEMA, version: DECISIONS_VERSION, as_of: '2026-11-18T12:00:00.000Z', ledger: 'available',
      waiting: 0, decisions: [], ignored: [], hint: null,
    });
  });

  it('one waiting decision answered "yes" from a verified id', () => {
    const report = foldDecisions([pay], [reply('Yes')], VERIFIED);
    expect(report.waiting).toBe(0);
    expect(report.decisions[0]).toMatchObject({
      code: '3f2a', state: 'answered', answer: 'yes',
      answered_by: { channel: 'telegram', sender_id: 'mason-phone', at: '2026-11-18T11:00:00.000Z' },
    });
    expect(report.ignored).toEqual([]);
  });

  it('the same answer from an unknown id is ignored and listed, and the decision keeps waiting', () => {
    const report = foldDecisions([pay], [reply('yes', 'stranger')], VERIFIED);
    expect(report.decisions[0]).toMatchObject({ state: 'waiting', answer: null, answered_by: null });
    expect(report.waiting).toBe(1);
    expect(report.ignored).toEqual([{ channel: 'telegram', sender_id: 'stranger', text: 'yes', at: '2026-11-18T11:00:00.000Z', reason: 'unverified sender' }]);
  });

  it('two waiting decisions and a bare "yes": both stay waiting, with a "say which one" hint naming each code', () => {
    const report = foldDecisions([pay, device], [reply('yes')], VERIFIED);
    expect(report.decisions.map(d => d.state)).toEqual(['waiting', 'waiting']);
    expect(report.waiting).toBe(2);
    expect(report.ignored).toEqual([expect.objectContaining({ text: 'yes', reason: 'say which one' })]);
    expect(report.hint).toBe('Say which one: "yes 3f2a" for: Pay the team plan this month; or "yes 9c1d" for: Approve the new laptop sign-in.');
  });

  it('quoting the code answers that one; then a bare word answers the only one left', () => {
    const report = foldDecisions([pay, device], [
      reply('9C1D n', 'mason', '2026-11-18T11:00:00.000Z', 'cli'),
      reply('later.', 'mason-phone', '2026-11-18T11:05:00.000Z'),
    ], VERIFIED);
    expect(report.decisions.map(d => [d.code, d.state, d.answer, d.answered_by?.channel])).toEqual([
      ['3f2a', 'answered', 'later', 'telegram'], ['9c1d', 'answered', 'no', 'cli'],
    ]);
    expect(report.hint).toBeNull();
  });

  it('an expired decision is expired, and a late reply to it is ignored', () => {
    const lapsed = { ...pay, expires_at: '2026-11-18T10:45:00.000Z' };
    const report = foldDecisions([lapsed], [reply('yes 3f2a')], VERIFIED);
    expect(report.decisions[0]).toMatchObject({ state: 'expired', answer: null, expires_at: '2026-11-18T10:45:00.000Z' });
    expect(report.waiting).toBe(0);
    expect(report.ignored).toEqual([expect.objectContaining({ reason: 'expired' })]);
  });

  it('the first answer wins; replies that are not one word, unknown codes or early ones are ignored with a reason', () => {
    const report = foldDecisions([pay], [
      reply('no', 'mason', '2026-11-18T11:30:00.000Z'),
      reply('yes', 'mason', '2026-11-18T11:00:00.000Z'),
      reply('yes 3f2a', 'mason', '2026-11-18T11:40:00.000Z'),
      reply('sure thing go ahead', 'mason', '2026-11-18T11:41:00.000Z'),
      reply('yes beef', 'mason', '2026-11-18T11:42:00.000Z'),
      reply('yes 3f2a', 'mason', '2026-11-18T09:00:00.000Z'),
      reply('yes', 'mason', 'whenever'),
    ], VERIFIED);
    expect(report.decisions[0]).toMatchObject({ state: 'answered', answer: 'yes', answered_by: { at: '2026-11-18T11:00:00.000Z' } });
    // Oldest first; a reply with no readable time goes last.
    expect(report.ignored.map(i => i.reason)).toEqual([
      'asked after this reply', 'nothing waiting', 'already answered', 'not a one-word answer', 'unknown code', 'unknown time',
    ]);
  });

  it('a bare answer with nothing waiting is ignored', () => {
    expect(foldDecisions([], [reply('y')], VERIFIED).ignored).toEqual([expect.objectContaining({ reason: 'nothing waiting' })]);
  });
});

describe('parseDecisionReply', () => {
  it('reads one word, y/n, and a quoted code on either side', () => {
    expect(parseDecisionReply('Y')).toEqual({ answer: 'yes', code: null });
    expect(parseDecisionReply(' no 3F2A. ')).toEqual({ answer: 'no', code: '3f2a' });
    expect(parseDecisionReply('#3f2a later')).toEqual({ answer: 'later', code: '3f2a' });
    for (const text of ['done', 'yes no', 'yes please do', '', 'maybe']) expect(parseDecisionReply(text)).toBeNull();
  });
});

describe('phm decisions', () => {
  const logs: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); logs.length = 0; });
  const capture = () => {
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { logs.push(String(line)); });
  };
  const report = (records: DecisionRecord[], ledger: DecisionsReport['ledger'] = 'available'): DecisionsReport =>
    foldDecisions(records, [], { verifiedSenderIds: ['mason'], now: NOW, ledger });

  it('--json prints decisions.v1 with schema and version; text says "Nothing needs you." when empty', async () => {
    capture();
    expect(await cmdDecisions(['--json'], { decisions: () => report([pay]) })).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({ schema: 'decisions.v1', version: 1, waiting: 1, decisions: [{ code: '3f2a', state: 'waiting' }] });
    expect(await cmdDecisions([], { decisions: () => report([]) })).toBe(0);
    expect(logs[1]).toBe('Nothing needs you.');
    expect(await cmdDecisions([], { decisions: () => report([pay]) })).toBe(0);
    expect(logs[2]).toContain('1 waiting on you. Answer with: phm decisions answer <code> yes|no|later');
    expect(logs[2]).toContain('3f2a   payment  asked 2h ago  Pay the team plan this month');
  });

  it('an unreadable ledger is unknown, exit 1', async () => {
    capture();
    expect(await cmdDecisions([], { decisions: () => report([], 'unavailable') })).toBe(1);
    expect(logs[0]).toBe('Decisions: unknown (the needs-you ledger could not be read).');
  });

  it('answer records the word through the approvals answer path as the local human; y means yes', async () => {
    capture();
    const answer = vi.fn(async () => ({ schema: 'approvals.answer.v1' as const, status: 'answered' as const, id: pay.id, ref: '3f2a', question: pay.question,
      answer: 'yes', answeredBy: 'mason', channel: 'cli', answeredAt: '2026-11-18T12:00:00.000Z', reason: null }));
    expect(await cmdDecisions(['answer', '3f2a', 'y'], { answer, localHuman: () => ({ id: 'me' }) as never })).toBe(0);
    expect(answer).toHaveBeenCalledWith('3f2a', 'yes', { channel: 'cli', senderId: 'mason' }, undefined);
    expect(logs[0]).toBe('Got it: "yes" to approval 3f2a: Pay the team plan this month');
  });

  it('an agent process answers as nobody, and anything but yes, no or later is usage', async () => {
    capture();
    const answer = vi.fn(async () => ({ schema: 'approvals.answer.v1' as const, status: 'unverified' as const, id: null, ref: null, question: null,
      answer: null, answeredBy: null, channel: 'cli', answeredAt: null, reason: 'Only Mason can answer.' }));
    expect(await cmdDecisions(['answer', '3f2a', 'no'], { answer, localHuman: () => { throw new Error('agent'); } })).toBe(1);
    expect(answer).toHaveBeenCalledWith('3f2a', 'no', { channel: 'cli', senderId: null }, undefined);
    for (const argv of [['answer', '3f2a', 'done'], ['answer', '3f2a'], ['answer', '3f2a', 'yes 3f2a'], ['later']]) {
      expect(await cmdDecisions(argv, { answer })).toBe(2);
    }
    expect(answer).toHaveBeenCalledTimes(1);
  });
});
