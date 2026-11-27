/**
 * CLI and MCP surface for the Comms role.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdCommsAgent } from '../src/cli/comms-agent.js';
import { callNativeTool } from '../src/core/mcp-native.js';
import { appendDraft, appendRunRecord, readRunJournal, writeInbox, type CommsDraft, type CommsRunRecord } from '../src/core/comms-agent/store.js';
import type { CommsTransport } from '../src/core/comms-agent/policy.js';

const roots: string[] = [];
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'comms-agent-cli-'));
  roots.push(root);
  return root;
};
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)); });
  return { lines, restore: () => spy.mockRestore() };
}

describe('phm comms-agent', () => {
  it('status and drafts are JSON and name no lane', async () => {
    const runsDir = temp();
    await writeInbox(runsDir, [
      { id: 'person-1', transport: 'email', from: 'ada@example.com', subject: 'Question', body: 'Can you look?' },
    ]);
    const run = capture();
    expect(await cmdCommsAgent(['run', '--dir', runsDir, '--lanes', 'claude', '--json'])).toBe(0);
    const report = JSON.parse(run.lines.at(-1) ?? '{}') as { lane: string | null; grokRequired: boolean; sends: Array<{ status: string }> };
    expect(report.grokRequired).toBe(false);
    expect(report.lane === null || report.lane === 'claude').toBe(true);
    expect(report.lane).not.toBe('grok');
    expect(report.sends).toEqual([expect.objectContaining({ status: 'drafted', reason: expect.stringContaining('standing approval') })]);
    run.restore();

    const drafts = capture();
    expect(await cmdCommsAgent(['drafts', '--dir', runsDir, '--json'])).toBe(0);
    const listed = JSON.parse(drafts.lines.at(-1) ?? '{}') as { drafts: Array<{ recipient: string; status: string }> };
    expect(listed.drafts.map(draft => draft.recipient)).toEqual(['ada@example.com']);
    expect(listed.drafts.every(draft => draft.status === 'pending')).toBe(true);
    drafts.restore();

    const status = capture();
    expect(await cmdCommsAgent(['status', '--dir', runsDir, '--json'])).toBe(0);
    const snapshot = JSON.parse(status.lines.at(-1) ?? '{}') as { role: { id: string; lane: null; grokRequired: boolean }; inbox: number | null; sendsLogged: number | null; standingApprovals: unknown };
    expect(snapshot.role.id).toBe('comms');
    expect(snapshot.role.lane).toBeNull();
    expect(snapshot.role.grokRequired).toBe(false);
    // The standing-approvals verdict is part of the status contract: an object
    // or null (unreadable), never absent.
    expect(snapshot).toHaveProperty('standingApprovals');
    // The kept 'person' message still awaits a sent reply's resolution pass, so
    // one pending inbox row remains; status reports the real depth, not a guess.
    expect(snapshot.inbox).toBe(1);
    expect(snapshot.sendsLogged).toBe(0);
    status.restore();
  }, 60_000);

  it('status reports inbox null when the inbox file cannot be read', async () => {
    const runsDir = temp();
    // A malformed inbox is unreadable, not empty: status must say unknown, never 0.
    mkdirSync(join(runsDir, 'comms-agent'), { recursive: true });
    writeFileSync(join(runsDir, 'comms-agent', 'inbox.json'), '{ not json', { mode: 0o600 });
    const status = capture();
    expect(await cmdCommsAgent(['status', '--dir', runsDir, '--json'])).toBe(0);
    const snapshot = JSON.parse(status.lines.at(-1) ?? '{}') as { inbox: number | null };
    expect(snapshot.inbox).toBeNull();
    status.restore();
  });

  it('status reports drafts and sendsLogged null when their logs cannot be read', async () => {
    const runsDir = temp();
    // A directory where a regular file belongs is unreadable, not empty:
    // status must say unknown, never a fabricated 0.
    mkdirSync(join(runsDir, 'comms-agent', 'drafts.jsonl'), { recursive: true });
    mkdirSync(join(runsDir, 'comms-agent', 'send-log.jsonl'), { recursive: true });
    const status = capture();
    expect(await cmdCommsAgent(['status', '--dir', runsDir, '--json'])).toBe(0);
    const snapshot = JSON.parse(status.lines.at(-1) ?? '{}') as { inbox: number | null; drafts: number | null; sendsLogged: number | null };
    expect(snapshot.drafts).toBeNull();
    expect(snapshot.sendsLogged).toBeNull();
    // A missing inbox file is verified empty, so inbox still reports a real 0.
    expect(snapshot.inbox).toBe(0);
    status.restore();
  });

  it('status reports the last completed pass from the run journal', async () => {
    const runsDir = temp();
    const statusJson = async (): Promise<{ lastRun: { source: string; run: Record<string, unknown> | null } }> => {
      const out = capture();
      expect(await cmdCommsAgent(['status', '--dir', runsDir, '--json'])).toBe(0);
      const parsed = JSON.parse(out.lines.at(-1) ?? '{}') as { lastRun: { source: string; run: Record<string, unknown> | null } };
      out.restore();
      return parsed;
    };

    // No pass has ever completed: the journal is verified empty, so
    // lastRun says missing — never an unreadable-store guess.
    expect(await statusJson()).toMatchObject({ lastRun: { source: 'missing', run: null } });

    await writeInbox(runsDir, [
      { id: 'person-1', transport: 'email', from: 'ada@example.com', subject: 'Question', body: 'Can you look?' },
      { id: 'bulk-1', transport: 'email', from: 'news@example.com', subject: 'News', body: 'Read more', labels: ['bulk'] },
      { id: 'unknown-1', transport: 'imessage', from: '', subject: '', body: 'no sender' },
    ]);
    const run = capture();
    expect(await cmdCommsAgent(['run', '--dir', runsDir, '--lanes', 'local', '--json'])).toBe(0);
    const report = JSON.parse(run.lines.at(-1) ?? '{}') as {
      lane: string | null;
      triage: { kept: number; archived: number; drafted: number };
      sends: Array<{ status: string }>;
    };
    run.restore();

    const snapshot = await statusJson();
    expect(snapshot.lastRun.source).toBe('available');
    const last = snapshot.lastRun.run;
    expect(last).not.toBeNull();
    expect(Date.parse(last!.at as string)).not.toBeNaN();
    expect(last!.lane).toBe(report.lane);
    expect(last!.kept).toBe(report.triage.kept);
    expect(last!.archived).toBe(report.triage.archived);
    expect(last!.drafted).toBe(report.triage.drafted);
    const outcomes = last!.sendOutcomes as { sent: number; drafted: number; refused: number };
    expect(outcomes.drafted).toBe(report.sends.filter(send => send.status === 'drafted').length);
    expect(outcomes.sent + outcomes.drafted + outcomes.refused).toBe(report.sends.length);

    // A second pass overwrites nothing: the journal keeps both records and
    // status reports the latest one.
    const second = capture();
    expect(await cmdCommsAgent(['run', '--dir', runsDir, '--json'])).toBe(0);
    second.restore();
    const journal = await readRunJournal(runsDir);
    expect(journal.status).toBe('ok');
    expect((await statusJson()).lastRun.source).toBe('available');
  }, 60_000);

  it('status reports lastRun unavailable when the run journal cannot be read', async () => {
    const runsDir = temp();
    // Garbage lines are skipped like every append-only log, but a journal
    // with no readable record cannot prove whether a pass ran: unknown,
    // never reported as never-ran.
    mkdirSync(join(runsDir, 'comms-agent'), { recursive: true });
    writeFileSync(join(runsDir, 'comms-agent', 'runs.jsonl'), '{ not json\n', { mode: 0o600 });
    const out = capture();
    expect(await cmdCommsAgent(['status', '--dir', runsDir, '--json'])).toBe(0);
    const snapshot = JSON.parse(out.lines.at(-1) ?? '{}') as { lastRun: { source: string; run: unknown } };
    out.restore();
    expect(snapshot.lastRun).toEqual({ source: 'unavailable', run: null });
  });

  it('the run journal keeps only the last valid record and refuses malformed appends', async () => {
    const runsDir = temp();
    const record = (at: string): CommsRunRecord => ({
      at,
      schema: 'comms-agent.run.v1',
      lane: 'local',
      laneReason: 'The router selected an available lane.',
      triage: { kept: 1, archived: 0, drafted: 1, deleted: 0 },
      sends: [{ transport: 'email', recipient: 'ada@example.com', status: 'drafted', reason: 'Needs owner approval.' }],
    });
    await appendRunRecord(runsDir, record('2026-01-01T00:00:00.000Z'));
    await appendRunRecord(runsDir, record('2026-01-02T00:00:00.000Z'));
    const journal = await readRunJournal(runsDir);
    expect(journal.status).toBe('ok');
    expect(journal.status === 'ok' && journal.record?.at).toBe('2026-01-02T00:00:00.000Z');
    await expect(appendRunRecord(runsDir, { ...record('2026-01-03T00:00:00.000Z'), sends: [{ transport: 'email', recipient: 'x', status: 'bogus' as never, reason: 'r' }] })).rejects.toThrow('Run record is not storable.');
  });

  it('drafts --status/--transport select pending or sent slices', async () => {
    const runsDir = temp();
    const draft = (id: string, status: 'pending' | 'sent', transport: CommsTransport): CommsDraft => ({
      id, status, transport,
      recipient: `${id}@example.com`, subject: `Subject ${id}`, body: `Body ${id}`,
      messageId: `msg-${id}`, createdAt: '2026-01-01T00:00:00.000Z',
      ...(status === 'sent' ? { resolvedAt: '2026-01-02T00:00:00.000Z' } : {}),
    });
    await appendDraft(runsDir, draft('d-pending-email', 'pending', 'email'));
    await appendDraft(runsDir, draft('d-pending-bus', 'pending', 'bus'));
    await appendDraft(runsDir, draft('d-sent-imessage', 'sent', 'imessage'));
    await appendDraft(runsDir, draft('d-sent-email', 'sent', 'email'));

    const ids = async (args: string[]): Promise<string[]> => {
      const out = capture();
      expect(await cmdCommsAgent([...args, '--dir', runsDir, '--json'])).toBe(0);
      const parsed = JSON.parse(out.lines.at(-1) ?? '{}') as { drafts: Array<{ id: string; status: string; resolvedAt?: string }> };
      out.restore();
      return parsed.drafts.map(row => row.id).sort();
    };

    // The default and explicit pending stay owner approvals only; sent and
    // all expose the resolved audit trail the store already keeps.
    expect(await ids(['drafts'])).toEqual(['d-pending-bus', 'd-pending-email']);
    expect(await ids(['drafts', '--status', 'pending'])).toEqual(['d-pending-bus', 'd-pending-email']);
    expect(await ids(['drafts', '--status', 'sent'])).toEqual(['d-sent-email', 'd-sent-imessage']);
    expect(await ids(['drafts', '--status', 'all'])).toEqual(['d-pending-bus', 'd-pending-email', 'd-sent-email', 'd-sent-imessage']);
    expect(await ids(['drafts', '--status', 'sent', '--transport', 'email'])).toEqual(['d-sent-email']);
    expect(await ids(['drafts', '--transport', 'bus'])).toEqual(['d-pending-bus']);

    // A sent record keeps its resolvedAt stamp on the read.
    const sentOut = capture();
    expect(await cmdCommsAgent(['drafts', '--status', 'sent', '--transport', 'imessage', '--dir', runsDir, '--json'])).toBe(0);
    const sentRows = (JSON.parse(sentOut.lines.at(-1) ?? '{}') as { drafts: Array<{ resolvedAt?: string }> }).drafts;
    sentOut.restore();
    expect(sentRows).toEqual([expect.objectContaining({ resolvedAt: '2026-01-02T00:00:00.000Z' })]);

    // Bad filter values and filters on the wrong verb are usage errors.
    expect(await cmdCommsAgent(['drafts', '--status', 'bogus', '--dir', runsDir, '--json'])).toBe(2);
    expect(await cmdCommsAgent(['drafts', '--transport', 'bogus', '--dir', runsDir, '--json'])).toBe(2);
    expect(await cmdCommsAgent(['status', '--status', 'sent', '--dir', runsDir, '--json'])).toBe(2);
    expect(await cmdCommsAgent(['run', '--transport', 'email', '--dir', runsDir, '--json'])).toBe(2);
  });

  it('ashlr_comms_agent_drafts accepts the same status and transport filters', async () => {
    const runsDir = temp();
    const draft = (id: string, status: 'pending' | 'sent', transport: CommsTransport): CommsDraft => ({
      id, status, transport,
      recipient: `${id}@example.com`, subject: `Subject ${id}`, body: `Body ${id}`,
      messageId: `msg-${id}`, createdAt: '2026-01-01T00:00:00.000Z',
      ...(status === 'sent' ? { resolvedAt: '2026-01-02T00:00:00.000Z' } : {}),
    });
    await appendDraft(runsDir, draft('m-pending-email', 'pending', 'email'));
    await appendDraft(runsDir, draft('m-sent-imessage', 'sent', 'imessage'));

    const previous = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = runsDir;
    try {
      const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
        result.content.map(part => part.type === 'text' ? part.text ?? '' : '').join('');
      const all = await callNativeTool('ashlr_comms_agent_drafts', { status: 'all' });
      expect(all.isError).toBeUndefined();
      const parsed = JSON.parse(text(all)) as { drafts: Array<{ id: string }> };
      expect(parsed.drafts.map(row => row.id).sort()).toEqual(['m-pending-email', 'm-sent-imessage']);

      const sent = await callNativeTool('ashlr_comms_agent_drafts', { status: 'sent', transport: 'imessage' });
      expect(sent.isError).toBeUndefined();
      expect((JSON.parse(text(sent)) as { drafts: Array<{ id: string }> }).drafts.map(row => row.id)).toEqual(['m-sent-imessage']);

      // The schema enum refuses an unknown status before the handler runs;
      // the handler refuses an unknown transport the same way the CLI does.
      const badStatus = await callNativeTool('ashlr_comms_agent_drafts', { status: 'bogus' });
      expect(badStatus.isError).toBe(true);
      const badTransport = await callNativeTool('ashlr_comms_agent_drafts', { transport: 'bogus' });
      expect(badTransport.isError).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
      else process.env.ASHLR_RUNS_DIR = previous;
    }
  });

  it('exposes status, drafts and run as native MCP tools', async () => {
    const runsDir = temp();
    const previous = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = runsDir;
    try {
      const status = await callNativeTool('ashlr_comms_agent_status', {});
      expect(status.isError).toBeUndefined();
      const text = status.content.map(part => part.type === 'text' ? part.text : '').join('');
      expect(JSON.parse(text)).toMatchObject({ role: { id: 'comms', lane: null, grokRequired: false } });
      const drafts = await callNativeTool('ashlr_comms_agent_drafts', {});
      expect(drafts.isError).toBeUndefined();
      const ran = await callNativeTool('ashlr_comms_agent_run', { lanes: 'local' });
      expect(ran.isError).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
      else process.env.ASHLR_RUNS_DIR = previous;
    }
  }, 60_000);
});
