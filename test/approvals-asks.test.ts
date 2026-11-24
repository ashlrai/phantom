/**
 * `phm approvals` asks (RQ-APPROVALSN18FQ8): fixture tests on a temp ledger and
 * bus for create, list, answer by a verified id, a rejected unverified id, an
 * expired ask, an ambiguous one-word reply and duplicate replay, plus the CLI,
 * HTTP and Telegram adapters. Hermetic: temp runs dir and bus root only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdApprovals, renderApprovals } from '../src/cli/approvals.js';
import { handleTelegramAskReply } from '../src/core/comms/telegram-ask-reply.js';
import {
  answerApproval, answerApprovalReply, approvalAnswerText, approvalOfLine, approvalsText, listApprovals, raiseApproval,
  type ApprovalAnswerer, type ApprovalsOptions,
} from '../src/core/fleet/approvals.js';
import { listAsks } from '../src/core/fleet/asks.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { readNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer.js';
import { createAgentBusApi } from '../src/core/verse/agent-bus-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';

const NOW = Date.parse('2026-11-17T15:00:00.000Z');
const MASON: ApprovalAnswerer = { channel: 'telegram', senderId: 'mason' };
let home = '';
let opts: Required<Pick<ApprovalsOptions, 'runsDir' | 'bus' | 'now'>>;
const ledger = () => join(opts.runsDir, 'NEEDS-MASON.md');
const busBodies = () => {
  const page = listBusInboxAfter(0, 100, opts.bus);
  return page.status === 'ok' ? page.messages.map(m => m.envelope.body as Record<string, unknown>) : [];
};
const raise = (question: string, options: string, extra: Record<string, unknown> = {}, now = NOW) => {
  const raised = raiseApproval({ question, options, askedBy: 'claude', ...extra }, { ...opts, now: () => now });
  if (!raised.ok) throw new Error(raised.reason);
  return raised;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'example-approvals-'));
  mkdirSync(join(home, 'runs'));
  opts = { runsDir: join(home, 'runs'), bus: { root: join(home, 'fleet'), now: () => NOW }, now: () => NOW };
  writeFileSync(ledger(), [
    '# Needs Mason',
    '- [ ] ask:device Approve the fake-device sign-in on the example laptop (asked 2026-11-17T14:00:00.000Z)',
    '- [ ] Pick a fake vendor for the example landing page',
    '',
  ].join('\n'));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('create and list', () => {
  it('numbers a new approval, lists it with question, options, asker, age and expiry, and keeps the asks in the same list', () => {
    const raised = raise('Use the $40 example credit on the fake plan?', 'Use it, not now', { expires: '2026-11-18T09:00:00Z' }, NOW - 300_000);
    expect(raised).toMatchObject({ ok: true, ref: '1', duplicate: false });
    expect(readFileSync(ledger(), 'utf8')).toContain('- [ ] approval #1: Use the $40 example credit on the fake plan? [use it|not now] (asked 2026-11-17T14:55:00.000Z by claude, expires 2026-11-18T09:00:00.000Z)');
    const list = listApprovals(opts);
    expect(Object.keys(list)).toEqual(['schema', 'asOf', 'ledger', 'count', 'approvals', 'expired']);
    expect(list).toMatchObject({ schema: 'approvals.asks.v1', asOf: '2026-11-17T15:00:00.000Z', ledger: 'available', count: 2, expired: 0 });
    const [device, credit] = list.approvals;
    expect(Object.keys(credit!)).toEqual(['id', 'ref', 'number', 'kind', 'question', 'options', 'askedBy', 'created', 'ageSeconds', 'expires']);
    expect(credit).toMatchObject({ ref: '1', number: 1, kind: 'approval', question: 'Use the $40 example credit on the fake plan?', options: ['use it', 'not now'],
      askedBy: 'claude', created: '2026-11-17T14:55:00.000Z', ageSeconds: 300, expires: '2026-11-18T09:00:00.000Z' });
    expect(device).toMatchObject({ number: null, kind: 'device', options: ['yes', 'no', 'later'], askedBy: null, ageSeconds: 3600 });
    // The `$40` wording must not turn the approval into a payment ask on the old asks list.
    expect(listAsks(opts)).toMatchObject({ count: 1, fleetDecides: 1 });
    expect(approvalsText(list)[2]).toMatch(/^ {2}1 +Use the \$40 .*\[use it \| not now\] {2}asked 5m ago by claude, expires 2026-11-18T09:00:00.000Z$/);
    expect(JSON.stringify(listApprovals(opts))).toBe(JSON.stringify(list));
  });

  it('reuses an identical open approval, keeps numbers growing and refuses bad input without writing', () => {
    const first = raise('Approve the fake device for the example runner?', 'yes,no');
    expect(raise('Approve the fake device for the example runner?', 'yes, no')).toEqual({ ...first, duplicate: true });
    expect(raise('Renew the example domain?', 'yes,no').ref).toBe('2');
    const before = readFileSync(ledger(), 'utf8');
    for (const [input, reason] of [
      [{ question: '', options: 'yes,no' }, /one plain line/],
      [{ question: 'Pick one?', options: 'yes' }, /2 to 6 options/],
      [{ question: 'Pick one?', options: 'yes,yes' }, /must differ/],
      [{ question: 'Pick one?', options: '1,2' }, /short word or phrase/],
      [{ question: 'Is it resolved?', options: 'yes,no' }, /resolved/],
      [{ question: 'Pick one?', options: 'yes,no', expires: '2026-11-17T14:00:00Z' }, /already past/],
      [{ question: 'Pick one?', options: 'yes,no', expires: 'tomorrow' }, /ISO time/],
    ] as const) expect(raiseApproval(input, opts)).toEqual({ ok: false, reason: expect.stringMatching(reason) });
    expect(readFileSync(ledger(), 'utf8')).toBe(before);
  });

  it('says missing for no ledger and unknown for an unreadable one', () => {
    rmSync(ledger());
    expect(listApprovals(opts)).toMatchObject({ ledger: 'missing', count: 0 });
    expect(approvalsText(listApprovals(opts))).toEqual(['Nothing needs your approval.']);
    mkdirSync(ledger());
    expect(listApprovals(opts)).toMatchObject({ ledger: 'unavailable', count: 0 });
    expect(approvalsText(listApprovals(opts))[0]).toMatch(/unknown/);
    expect(raiseApproval({ question: 'Pick one?', options: 'yes,no' }, opts)).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be read/) });
  });

  it('parses only well-formed approval lines', () => {
    expect(approvalOfLine('approval #4: Pick? [yes|no] (asked 2026-11-17T14:00:00.000Z by unknown)')).toMatchObject({ number: 4, askedBy: null, expires: null });
    expect(approvalOfLine('approval #4: Pick? [yes] (asked 2026-11-17T14:00:00.000Z by claude)')).toBeNull();
    expect(approvalOfLine('approval: Pick? [yes|no]')).toBeNull();
  });
});

describe('answer', () => {
  it('records a verified answer once with who, channel and time, and the approval leaves the list', async () => {
    const { id } = raise('Use the example credit?', 'use it,not now');
    const outcome = await answerApproval('1', 'Use it', MASON, opts);
    expect(outcome).toEqual({ schema: 'approvals.answer.v1', status: 'answered', id, ref: '1', question: 'Use the example credit?', answer: 'use it',
      answeredBy: 'mason', channel: 'telegram', answeredAt: '2026-11-17T15:00:00.000Z', reason: null });
    expect(busBodies()).toEqual([expect.objectContaining({ kind: 'needs_mason.resolved', itemId: id, reply: 'use it', source: 'telegram', answeredBy: 'mason' })]);
    expect(readNeedsMasonAnswer(id, opts.bus)).toMatchObject({ status: 'found', answer: { reply: 'use it', source: 'telegram', answeredBy: 'mason' } });
    expect(listApprovals(opts).approvals.map(a => a.id)).not.toContain(id);
    expect(approvalAnswerText(outcome)).toBe('Got it: "use it" to approval 1: Use the example credit?');
  });

  it('rejects an unverified id and an agent relay without reading or writing anything', async () => {
    raise('Use the example credit?', 'use it,not now');
    const before = readFileSync(ledger(), 'utf8');
    for (const answerer of [{ channel: 'telegram', senderId: null }, { channel: 'telegram', senderId: 'someone-else' }, { channel: 'leader', senderId: 'mason' }] as ApprovalAnswerer[]) {
      expect(await answerApproval('1', 'use it', answerer, opts)).toMatchObject({ status: 'unverified', id: null, reason: expect.stringMatching(/Only Mason can answer/) });
    }
    expect(await answerApprovalReply('use it', { channel: 'telegram', senderId: null }, opts)).toBeNull();
    expect(busBodies()).toEqual([]);
    expect(readFileSync(ledger(), 'utf8')).toBe(before);
  });

  it('refuses an expired approval, drops it from the list and counts it', async () => {
    raise('Approve the example device?', 'yes,no', { expires: '2026-11-17T15:30:00Z' });
    const later = { ...opts, now: () => NOW + 3_600_000 };
    expect(listApprovals(later)).toMatchObject({ count: 1, expired: 1 });
    expect(approvalsText(listApprovals(later)).at(-1)).toBe('1 expired; they can no longer be answered.');
    expect(await answerApproval('#1', 'yes', MASON, later)).toMatchObject({ status: 'expired', ref: '1', reason: expect.stringMatching(/expired at 2026-11-17T15:30:00.000Z/) });
    expect(busBodies()).toEqual([]);
  });

  it('is idempotent: a replay, even a different option or channel, changes nothing and returns the first answer', async () => {
    const { id } = raise('Use the example credit?', 'use it,not now');
    expect((await answerApproval('1', 'use it', MASON, opts)).status).toBe('answered');
    const before = readFileSync(ledger(), 'utf8');
    for (const [ref, option] of [['1', 'use it'], [id, 'not now'], [id.slice(3, 9), 'use it']]) {
      expect(await answerApproval(ref, option, { channel: 'cli', senderId: 'mason' }, { ...opts, now: () => NOW + 60_000 })).toMatchObject({
        status: 'already-answered', id, answer: 'use it', channel: 'telegram', answeredBy: 'mason', answeredAt: '2026-11-17T15:00:00.000Z' });
    }
    expect(busBodies()).toHaveLength(1);
    expect(readFileSync(ledger(), 'utf8')).toBe(before);
  });

  it('refuses an option the approval does not offer, a bad ref and an unknown number', async () => {
    raise('Use the example credit?', 'use it,not now');
    expect(await answerApproval('1', 'maybe', MASON, opts)).toMatchObject({ status: 'invalid', reason: 'Answer one of: use it, not now.' });
    expect(await answerApproval('not a ref', 'yes', MASON, opts)).toMatchObject({ status: 'invalid' });
    expect(await answerApproval('9', 'yes', MASON, opts)).toMatchObject({ status: 'unknown' });
    expect(busBodies()).toEqual([]);
  });
});

describe('channel replies', () => {
  it('"yes 3" style replies answer that approval; a bare option answers when exactly one approval offers it', async () => {
    raise('Use the example credit?', 'use it,not now');
    raise('Approve the example device?', 'approve,deny');
    expect(await answerApprovalReply('approve 2', MASON, opts)).toMatchObject({ status: 'answered', ref: '2', answer: 'approve' });
    expect(await answerApprovalReply('Use it.', MASON, opts)).toMatchObject({ status: 'answered', ref: '1', answer: 'use it' });
    expect(await answerApprovalReply('how is the fleet doing', MASON, opts)).toBeNull();
  });

  it('an ambiguous one-word reply asks which one in plain words and records nothing', async () => {
    raise('Use the example credit?', 'yes,no');
    raise('Renew the example domain?', 'yes,no');
    const outcome = await answerApprovalReply('yes', MASON, opts);
    // The device ask also takes yes, so three fit.
    expect(outcome).toMatchObject({ status: 'ambiguous', id: null });
    const device = listApprovals(opts).approvals[0]!;
    expect(approvalAnswerText(outcome!)).toBe(`Which one? "yes" fits 3 approvals. Reply "yes ${device.ref}" for: ${device.question}; or "yes 1" for: Use the example credit?; or "yes 2" for: Renew the example domain?.`);
    expect(busBodies()).toEqual([]);
    expect(await answerApprovalReply('yes 7', MASON, opts)).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/^No open approval is 7\. Which one\?|^No open approval is 7\. Reply/) });
    expect(await answerApprovalReply('yes 2', MASON, opts)).toMatchObject({ status: 'answered', ref: '2' });
  });

  it('Telegram: Mason’s own chat answers "use it" and gets a plain reply; anyone else is left alone', async () => {
    raise('Use the example credit?', 'use it,not now');
    const cfg = { comms: { telegram: { chatId: '4242' } } } as AshlrConfig;
    const send = vi.fn(async () => ({ ok: true as const }));
    const stranger = { kind: 'text' as const, fromChatId: '9999', senderUserId: 9999, privateChat: true };
    expect(await handleTelegramAskReply(stranger, 'use it', cfg, { send, options: opts })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    const mason = { kind: 'text' as const, fromChatId: '4242', senderUserId: 4242, privateChat: true, messageId: 9 };
    expect(await handleTelegramAskReply(mason, 'use it', cfg, { send, options: opts })).toBe(true);
    expect(send).toHaveBeenLastCalledWith('Got it: "use it" to approval 1: Use the example credit?', { replyToMessageId: 9 }, cfg);
    expect(busBodies()).toEqual([expect.objectContaining({ source: 'telegram', reply: 'use it', answeredBy: 'mason' })]);
  });
});

describe('phm approvals', () => {
  let out: string[] = [];
  beforeEach(() => { out = []; vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); }); vi.spyOn(console, 'error').mockImplementation(() => {}); });

  it('ask, list as approvals.v1 JSON, and answer as the local human', async () => {
    expect(await cmdApprovals(['ask', '--question', 'Use the example credit?', '--options', 'use it,not now', '--by', 'claude', '--json'], { options: opts })).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ schema: 'approvals.ask.v1', ok: true, ref: '1', duplicate: false });
    expect(await cmdApprovals(['--json'], { options: opts })).toBe(0);
    const projection = JSON.parse(out.at(-1)!);
    expect(projection).toMatchObject({ schema: 'approvals.v1', asks: { schema: 'approvals.asks.v1', count: 2 } });
    expect(projection.asks.approvals[1]).toMatchObject({ ref: '1', options: ['use it', 'not now'], askedBy: 'claude' });
    expect(renderApprovals(projection).split('\n')[0]).toBe('2 waiting on you. Answer with: phm approvals answer <ref> <option>');
    const localHuman = vi.fn(() => ({ kind: 'human' as const, id: 'human:example' }));
    expect(await cmdApprovals(['answer', '1', 'use', 'it', '--json'], { options: opts, localHuman })).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ status: 'answered', channel: 'cli', answeredBy: 'mason', answer: 'use it' });
  });

  it('refuses an agent process: the answer is unverified and nothing is recorded', async () => {
    raise('Use the example credit?', 'use it,not now');
    const localHuman = vi.fn(() => { throw new Error('Approvals must come from the local human owner, not an agent process (CLAUDECODE is set).'); });
    expect(await cmdApprovals(['answer', '1', 'use it'], { options: opts, localHuman })).toBe(1);
    expect(out.at(-1)).toMatch(/Only Mason can answer/);
    expect(busBodies()).toEqual([]);
  });

  it('bad usage exits 2', async () => {
    expect(await cmdApprovals(['ask', '--question', 'Pick?'], { options: opts })).toBe(2);
    expect(await cmdApprovals(['ask', '--question', 'Pick?', '--options', 'yes,no', '--pay'], { options: opts })).toBe(2);
    expect(await cmdApprovals(['answer', '1'], { options: opts })).toBe(2);
    expect(await cmdApprovals(['bogus'], { options: opts })).toBe(2);
  });
});

describe('HTTP', () => {
  async function call(method: string, path: string, body?: unknown) {
    const handler = createAgentBusApi({
      approvals: { list: () => listApprovals(opts), answer: (ref, option, answerer) => answerApproval(ref, option, answerer, opts) },
    });
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
    req.url = path; req.method = method;
    req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'example-unlock' };
    let status = 0, wire: Record<string, unknown> = {};
    const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; },
      end(text: string) { wire = JSON.parse(text) as Record<string, unknown>; } } as unknown as ServerResponse;
    const ctx = { cfg: {}, token: 'example-unlock', allowDispatch: true,
      readSession: { id: 'example-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
    await handler(ctx, req, res, path, method);
    return { status, body: wire };
  }

  it('GET lists approvals.asks.v1; POST records the phone answer as Mason and maps statuses', async () => {
    raise('Use the example credit?', 'use it,not now', { expires: '2026-11-17T16:00:00Z' });
    const list = await call('GET', '/api/verse/agent-bus/needs-mason/approvals');
    expect(list).toMatchObject({ status: 200, body: { schema: 'approvals.asks.v1', count: 2 } });
    expect(await call('POST', '/api/verse/agent-bus/needs-mason/approvals/answer', { id: '1', option: 'nope' })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/verse/agent-bus/needs-mason/approvals/answer', { id: '1', option: 'use it', who: 'evil' })).toMatchObject({ status: 400 });
    expect(await call('POST', '/api/verse/agent-bus/needs-mason/approvals/answer', { id: '1', option: 'use it', from: 'phone' }))
      .toMatchObject({ status: 200, body: { status: 'answered', channel: 'phone', answeredBy: 'mason' } });
    expect(await call('POST', '/api/verse/agent-bus/needs-mason/approvals/answer', { id: '1', option: 'use it' })).toMatchObject({ status: 200, body: { status: 'already-answered' } });
    expect(await call('POST', '/api/verse/agent-bus/needs-mason/approvals/answer', { id: '9', option: 'yes' })).toMatchObject({ status: 404 });
  });
});
