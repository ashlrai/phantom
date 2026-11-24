/**
 * `phm fleet pending-approvals` — read-only inventory over the real stores.
 *
 * Every fixture is written through the real store APIs under a temporary HOME
 * (inbox proposals, email drafts, team event logs). The aggregation itself is
 * never mocked; the only injected seam is the CLI reader, used to prove that
 * help and invalid arguments perform no reads at all.
 */
import { mkdirSync, mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPendingApprovals } from '../src/cli/fleet-pending-approvals.js';
import {
  readPendingApprovalsInventory,
  type PendingApprovalsReport,
} from '../src/core/fleet/pending-approvals-read.js';
import { createProposal, setStatus } from '../src/core/inbox/store.js';
import { createDraft, draftsDir, rejectDraft } from '../src/core/cos/drafts.js';
import { appendEvent, readEvents } from '../src/core/teams/store.js';
import { requestHandoff, type TeamActor } from '../src/core/teams/index.js';

const TEAM = 'pending-approvals-626s';
const OTHER_TEAM = 'pending-approvals-626s-b';
const agent: TeamActor = { kind: 'agent', id: 'agent:codex/acct-1', provider: 'codex' };
const human: TeamActor = { kind: 'human', id: 'human:fixture-owner' };

// Plainly fake markers. None may appear in any inventory output.
const BODY_MARKER = 'BODY-MARKER-7f3a';
const RECIPIENT_MARKER = 'recipient-marker@example.test';
const SUBJECT_MARKER = 'SUBJECT-MARKER-91c';
const SUMMARY_MARKER = 'SUMMARY-MARKER-22d';
const TITLE_MARKER = 'HANDOFF-TITLE-MARKER-5e';
const MARKERS = [BODY_MARKER, RECIPIENT_MARKER, SUBJECT_MARKER, SUMMARY_MARKER, TITLE_MARKER];

let home: string;
let savedHome: string | undefined;
let savedAshlrHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pending-approvals-626s-'));
  savedHome = process.env['HOME'];
  savedAshlrHome = process.env['ASHLR_HOME'];
  process.env['HOME'] = home;
  delete process.env['ASHLR_HOME'];
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
  if (savedAshlrHome === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = savedAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

function seedProposal(title: string) {
  return createProposal({ repo: null, origin: 'manual', kind: 'note', title, summary: SUMMARY_MARKER });
}

async function seedDraft(subject: string, source: string) {
  return createDraft({ to: RECIPIENT_MARKER, subject, body: BODY_MARKER, source });
}

function seedTeamApproval(team: string, title: string): string {
  const handoff = requestHandoff(team, agent, { title: `${TITLE_MARKER} ${title}`, detail: BODY_MARKER, action: 'release' }) as { approvalId: string };
  return handoff.approvalId;
}

async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { err.push(parts.map(String).join(' ')); });
  try {
    const code = await cmdFleetPendingApprovals(args);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

function sourceIds(report: PendingApprovalsReport, source: string): string[] {
  return report.items.filter(item => item.source === source).map(item => item.id);
}

describe('pending-approvals: argument handling', () => {
  it('help returns 0 without reading any store', async () => {
    const reader = vi.fn(async () => { throw new Error('must not read'); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetPendingApprovals(['--help'], reader)).toBe(0);
    expect(await cmdFleetPendingApprovals(['-h'], reader)).toBe(0);
    expect(reader).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain('phm fleet pending-approvals [--json]');
    expect(String(log.mock.calls[0]?.[0])).toContain('Read-only');
  });

  it.each([
    [['--bogus']],
    [['--json', '--json']],
    [['extra']],
    [['--json', 'extra']],
    [['--help', '--json']],
  ])('rejects %j with exit 2 before any read', async (args) => {
    const reader = vi.fn(async () => { throw new Error('must not read'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetPendingApprovals(args, reader)).toBe(2);
    expect(reader).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toContain('Usage: phm fleet pending-approvals [--json]');
  });
});

describe('pending-approvals: real stores under a temporary HOME', () => {
  it('lists all three source kinds with ids, kind, state and request time, and no content', async () => {
    const proposal = seedProposal('Proposal title');
    const draft = await seedDraft(SUBJECT_MARKER, 'outbox-1.json');
    const approvalId = seedTeamApproval(TEAM, 'ship');

    const result = await runCli(['--json']);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as PendingApprovalsReport;

    expect(report.schema).toBe('fleet.pending-approvals.v1');
    expect(report.readOnly).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.truncated).toBe(false);
    expect(report.sources.proposal).toMatchObject({ sourceState: 'healthy', complete: true, count: 1 });
    expect(report.sources.draft).toMatchObject({ sourceState: 'healthy', complete: true, count: 1 });
    expect(report.sources['team-approval']).toMatchObject({ sourceState: 'healthy', complete: true, count: 1 });

    expect(sourceIds(report, 'proposal')).toEqual([`proposal:${proposal.id}`]);
    expect(sourceIds(report, 'draft')).toEqual([`draft:${draft.id}`]);
    expect(sourceIds(report, 'team-approval')).toEqual([`team-approval:${TEAM}:${approvalId}`]);

    const teamRow = report.items.find(item => item.source === 'team-approval')!;
    expect(teamRow).toMatchObject({ kind: 'team:release', state: 'pending' });
    const requested = readEvents(TEAM).find(ev => ev.type === 'approval.requested' && ev.id === approvalId);
    expect(teamRow.createdAt).toBe(new Date(requested!.ts).toISOString());

    for (const item of report.items) {
      expect(item.state).toBe('pending');
      expect(item.createdAt).not.toBeNull();
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'id', 'kind', 'source', 'state']);
    }
    for (const marker of MARKERS) {
      expect(result.out).not.toContain(marker);
    }
    expect(result.out).not.toMatch(/"(body|to|recipient|subject|summary|title|detail|parameters|diff|path)"/);
  });

  it('human text states read-only and shows the same rows', async () => {
    seedProposal('Human text proposal');
    const result = await runCli([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('read-only');
    expect(result.out).toContain('Nothing was approved, denied, sent or dispatched');
    expect(result.out).toContain('proposal: healthy');
    expect(result.out).toContain('Status: complete');
    expect(result.out).toMatch(/proposal:\S+\s+note\s+\d{4}-\d{2}-\d{2}T/);
    for (const marker of MARKERS) expect(result.out).not.toContain(marker);
  });

  it('excludes resolved records and reports an existing-but-empty store as healthy, not missing', async () => {
    const proposal = seedProposal('Will be rejected');
    setStatus(proposal.id, 'rejected');
    const draft = await seedDraft('Will be rejected too', 'outbox-2.json');
    await rejectDraft(draft.id);
    const approvalId = seedTeamApproval(TEAM, 'deny me');
    // Fixture-only: the owner membership and decision are appended straight to the team log, because
    // decideApproval refuses agent-marked environments. The fold still enforces owner/admin.
    appendEvent(TEAM, human, 'member.joined', { memberId: human.id, role: 'owner' });
    appendEvent(TEAM, human, 'approval.decided', { approvalId, decision: 'deny' });

    const report = await readPendingApprovalsInventory();
    expect(report.items).toEqual([]);
    expect(report.count).toBe(0);
    expect(report.complete).toBe(true);
    for (const source of ['proposal', 'draft', 'team-approval'] as const) {
      expect(report.sources[source]).toMatchObject({ sourceState: 'healthy', complete: true, count: 0 });
    }
  });

  it('reports a fresh home as missing stores, distinct from healthy empty', async () => {
    const report = await readPendingApprovalsInventory();
    expect(report.items).toEqual([]);
    expect(report.complete).toBe(true);
    for (const source of ['proposal', 'draft', 'team-approval'] as const) {
      expect(report.sources[source]).toMatchObject({ sourceState: 'missing', complete: true, count: 0 });
    }
  });

  it('a malformed draft store degrades only the draft slice; other sources stay visible', async () => {
    const proposal = seedProposal('Still visible');
    await seedDraft(SUBJECT_MARKER, 'outbox-3.json');
    const approvalId = seedTeamApproval(TEAM, 'still visible');
    appendFileSync(join(draftsDir(), 'drafts.jsonl'), 'this is not json\n');

    const result = await runCli(['--json']);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as PendingApprovalsReport;
    expect(report.sources.draft.sourceState).toBe('degraded');
    expect(report.sources.draft.complete).toBe(false);
    expect(report.sources.draft.reasons).toContain('1 draft line(s) unreadable');
    expect(report.complete).toBe(false);
    expect(sourceIds(report, 'draft')).toHaveLength(1);
    expect(sourceIds(report, 'proposal')).toEqual([`proposal:${proposal.id}`]);
    expect(sourceIds(report, 'team-approval')).toEqual([`team-approval:${TEAM}:${approvalId}`]);
    expect(report.sources.proposal.sourceState).toBe('healthy');
    expect(report.sources['team-approval'].sourceState).toBe('healthy');
    const human = await runCli([]);
    expect(human.out).toContain('Status: INCOMPLETE');
    expect(human.out).toContain('draft: degraded (incomplete)');
  });

  it('an unreadable draft store yields a degraded draft slice, never a healthy empty one', async () => {
    seedProposal('Survivor');
    // A directory where the file should be: the store exists but cannot be read.
    mkdirSync(join(draftsDir(), 'drafts.jsonl'), { recursive: true });

    const report = await readPendingApprovalsInventory();
    expect(report.sources.draft).toMatchObject({ sourceState: 'degraded', complete: false, count: 0 });
    expect(report.sources.draft.reasons).toEqual(['draft store unreadable']);
    expect(report.items.map(item => item.source)).toEqual(['proposal']);
    expect(report.complete).toBe(false);
  });

  it('a malformed proposal file degrades the proposal slice while valid proposals remain', async () => {
    const good = seedProposal('Valid proposal');
    writeFileSync(join(home, '.ashlr', 'inbox', 'corrupt-626s.json'), '{not json');

    const report = await readPendingApprovalsInventory();
    expect(report.sources.proposal.sourceState).toBe('degraded');
    expect(report.sources.proposal.complete).toBe(false);
    expect(report.sources.proposal.reasons.some(reason => reason.includes('proposal file'))).toBe(true);
    expect(report.items.map(item => item.id)).toEqual([`proposal:${good.id}`]);
    expect(report.complete).toBe(false);
  });

  it('a corrupt team log degrades only that team; a valid team stays visible', async () => {
    const approvalId = seedTeamApproval(TEAM, 'good team');
    mkdirSync(join(home, '.ashlr', 'teams', OTHER_TEAM), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'teams', OTHER_TEAM, 'events.jsonl'), 'garbage line\nmore garbage\n');
    mkdirSync(join(home, '.ashlr', 'teams', 'unreadable-626s', 'events.jsonl'), { recursive: true });

    const report = await readPendingApprovalsInventory();
    expect(report.sources['team-approval'].sourceState).toBe('degraded');
    expect(report.sources['team-approval'].complete).toBe(false);
    expect(report.sources['team-approval'].reasons).toEqual(expect.arrayContaining([
      '2 team log line(s) skipped',
      '1 team log(s) unreadable',
    ]));
    expect(sourceIds(report, 'team-approval')).toEqual([`team-approval:${TEAM}:${approvalId}`]);
    expect(report.complete).toBe(false);
  });

  it('caps are deterministic, oldest-first, and explicitly incomplete', async () => {
    const created = [seedProposal('one'), seedProposal('two'), seedProposal('three')];
    const first = await readPendingApprovalsInventory({ maxPerSource: 2 });
    const second = await readPendingApprovalsInventory({ maxPerSource: 2 });

    expect(first.items).toEqual(second.items);
    expect(first.sources.proposal).toMatchObject({ sourceState: 'healthy', complete: false, count: 2, truncated: true });
    expect(first.sources.proposal.reasons).toEqual(['per-source cap of 2 reached']);
    expect(first.truncated).toBe(true);
    expect(first.complete).toBe(false);
    expect(first.items).toHaveLength(2);
    const ages = first.items.map(item => Date.parse(item.createdAt!));
    expect(ages[0]).toBeLessThanOrEqual(ages[1]!);
    expect(created.map(p => `proposal:${p.id}`)).toEqual(expect.arrayContaining(first.items.map(item => item.id)));

    const globalCap = await readPendingApprovalsInventory({ maxItems: 1 });
    expect(globalCap.count).toBe(1);
    expect(globalCap.truncated).toBe(true);
    expect(globalCap.complete).toBe(false);
  });

  it('a team cap is reported as incomplete, not as a complete team inventory', async () => {
    seedTeamApproval(TEAM, 'a');
    seedTeamApproval(OTHER_TEAM, 'b');
    const report = await readPendingApprovalsInventory({ maxTeams: 1 });
    expect(report.sources['team-approval']).toMatchObject({ sourceState: 'healthy', complete: false, truncated: true });
    expect(report.complete).toBe(false);
    expect(report.truncated).toBe(true);
    expect(report.items.every(item => item.source === 'team-approval')).toBe(true);
    expect(new Set(report.items.map(item => item.id.split(':')[1]))).toEqual(new Set([TEAM]));
  });

  it('clamps caller caps to bounded values and reports the effective caps', async () => {
    const report = await readPendingApprovalsInventory({ maxItems: 10_000_000, maxPerSource: -4, maxTeams: Number.NaN });
    expect(report.caps).toEqual({ maxItems: 1000, maxPerSource: 100, maxTeams: 32 });
  });
});
