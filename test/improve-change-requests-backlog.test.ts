import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANGE_REQUEST_MIN_CELL,
  CHANGE_REQUEST_TAIL_BYTES,
  changeRequestsBacklogItems,
  classifyChangeRequest,
  foldChangeRequestEvidence,
  parseChangeRequestEntry,
  parseChangeRequestText,
  type ChangeRequestRow,
} from '../src/core/improve/change-requests-backlog.js';
import { changeRequestStatusPath, submitChangeRequest } from '../src/core/verse/change-request.js';
import { validBacklogItem } from '../src/core/cloud/backlog.js';

let tempRoot: string;
let runsRoot: string;
let statusRoot: string;
const NOW = Date.parse('2026-12-01T12:00:00.000Z');

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'improve-change-requests-'));
  runsRoot = join(tempRoot, 'runs');
  statusRoot = join(tempRoot, 'router');
});
afterEach(async () => rm(tempRoot, { recursive: true, force: true }));

let counter = 0;
const request = async (surface: string, description = `Change ${++counter}`): Promise<{ id: string; jobId: string }> => {
  const result = await submitChangeRequest({ description, surface }, { runsRoot, statusRoot, now: () => NOW });
  if (result.status !== 'queued') throw new Error(`expected queued, got ${result.status}`);
  return { id: result.jobId.slice(7), jobId: result.jobId };
};

/** A rejected drop-ingest fate: the done/ filename suffix is the recorded reason. */
const reject = async (id: string, reason = 'denied-path'): Promise<void> => {
  await mkdir(join(runsRoot, 'leader', 'drop', 'done'), { recursive: true });
  await writeFile(join(runsRoot, 'leader', 'drop', 'done', `RQ-PHX-${id}.md.${reason}`), 'rejected prompt\n');
};

/** An ingested fate; `queued` leaves the prompt file in queue/prompts. */
const ingest = async (id: string, at = '2026-11-30 10:00:00', queued = false): Promise<void> => {
  await mkdir(join(runsRoot, 'leader', 'drop'), { recursive: true });
  await writeFile(join(runsRoot, 'leader', 'drop', 'ingested.tsv'),
    `${at}\tRQ-PHX-${id}\tclaude\tcodex-personal\twork\tchange request\n`, { flag: 'a' });
  if (queued) {
    await mkdir(join(runsRoot, 'queue', 'prompts'), { recursive: true });
    await writeFile(join(runsRoot, 'queue', 'prompts', `RQ-PHX-${id}.md`), 'queued prompt\n');
  }
};

/** A resolved phantom PR in the given terminal state for a jobId. */
const prState = async (jobId: string, n: number, state: 'OPEN' | 'MERGED' | 'CLOSED'): Promise<void> => {
  const url = `https://github.com/ashlrai/phantom/pull/${n}`;
  await writeFile(join(runsRoot, `${jobId}.publish`), `RESULT PR ${url} SENS=[]\nAUTO_MERGE on\n`);
  await mkdir(join(runsRoot, 'metrics'), { recursive: true });
  await writeFile(join(runsRoot, 'metrics', 'jobs.jsonl'), [
    JSON.stringify({ event: 'publish', jobId, prUrl: `${url}/`, outcome: 'PUBLISHED' }),
    JSON.stringify({ event: 'publish', jobId, prUrl: url, outcome: state, source: 'metrics-outcomes-reconciler' }),
  ].join('\n') + '\n', { flag: 'a' });
};

const items = (over: Record<string, unknown> = {}) =>
  changeRequestsBacklogItems({
    repo: 'ashlrai/phantom',
    statusPath: changeRequestStatusPath(statusRoot),
    runsRoot,
    now: () => NOW,
    ...over,
  });

describe('parseChangeRequestEntry / parseChangeRequestText', () => {
  const good = (over: Record<string, unknown> = {}) => JSON.stringify({
    v: 1, id: 'UIREQ0123456789AB', jobId: 'RQ-PHX-UIREQ0123456789AB',
    surface: 'chat', createdAt: '2026-11-30T10:00:00.000Z', status: 'queued', ...over,
  });

  it('accepts the writer contract and rejects off-contract rows', () => {
    expect(parseChangeRequestEntry(JSON.parse(good()))).toMatchObject({
      id: 'UIREQ0123456789AB', jobId: 'RQ-PHX-UIREQ0123456789AB', surface: 'chat',
    });
    for (const bad of [
      null, 'x', [],
      JSON.parse(good({ v: 2 })),
      JSON.parse(good({ id: 'NOPE0123456789AB' })),
      JSON.parse(good({ id: 'UIREQ0123456789AG' })),
      JSON.parse(good({ jobId: 'RQ-PHX-OTHER' })),
      JSON.parse(good({ surface: '../escape' })),
      JSON.parse(good({ createdAt: 'not-a-date' })),
      JSON.parse(good({ status: 'done' })),
      JSON.parse(good({ surface: 'Chat' })),
    ]) {
      expect(parseChangeRequestEntry(bad)).toBeNull();
    }
    // Writer-added metadata beyond the contract fields is tolerated.
    expect(parseChangeRequestEntry(JSON.parse(good({ extra: 'field' })))!.surface).toBe('chat');
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows, invalidRows } = parseChangeRequestText([
      'not json',
      '{"v":1}',
      good(),
      '',
      good({ status: 'done' }),
    ].join('\n'));
    expect(rows).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('classifyChangeRequest', () => {
  const row: ChangeRequestRow = {
    atMs: NOW, utcDay: '2026-12-01', id: 'UIREQ0123456789AB',
    jobId: 'RQ-PHX-UIREQ0123456789AB', surface: 'chat',
  };
  const fate = (fate: 'ingested' | 'rejected', queued = false) =>
    ({ id: row.id, fate, at: '', lane: null, tier: null, reason: null, ageSeconds: 0, queued }) as never;
  const pr = (state: 'open' | 'merged' | 'closed' | null) => ({ url: 'u', state }) as never;

  it('orders rejected, PR state, queued, ingested, unknown', () => {
    expect(classifyChangeRequest(row, fate('rejected'), pr('closed'))).toBe('rejected');
    expect(classifyChangeRequest(row, null, pr('closed'))).toBe('closed-unmerged');
    expect(classifyChangeRequest(row, null, pr('merged'))).toBe('merged');
    expect(classifyChangeRequest(row, null, pr('open'))).toBe('open');
    expect(classifyChangeRequest(row, fate('ingested', true), null)).toBe('queued');
    expect(classifyChangeRequest(row, fate('ingested'), null)).toBe('ingested');
    expect(classifyChangeRequest(row, null, null)).toBe('unknown');
    expect(classifyChangeRequest(row, undefined, undefined)).toBe('unknown');
  });
});

describe('foldChangeRequestEvidence', () => {
  const row = (id: string, surface: string, day: string): ChangeRequestRow => ({
    atMs: Date.parse(`${day}T10:00:00.000Z`), utcDay: day, id, jobId: `RQ-PHX-${id}`, surface,
  });
  const cls = (r: ChangeRequestRow, outcome: 'rejected' | 'closed-unmerged' | 'merged' | 'unknown') => ({ row: r, outcome });

  it('emits only cells at the recurrence bar and carries context tallies', () => {
    const folded = foldChangeRequestEvidence([
      cls(row('UIREQ000000000001', 'chat', '2026-11-28'), 'rejected'),
      cls(row('UIREQ000000000002', 'chat', '2026-11-29'), 'rejected'),
      cls(row('UIREQ000000000003', 'chat', '2026-11-30'), 'merged'),
      cls(row('UIREQ000000000004', 'fleet', '2026-11-29'), 'rejected'), // single: below bar
      cls(row('UIREQ000000000005', 'chat', '2026-11-30'), 'unknown'),
    ]);
    expect(folded.records).toBe(5);
    expect(folded.cells).toHaveLength(1);
    const cell = folded.cells[0]!;
    expect(cell.surface).toBe('chat');
    expect(cell.klass).toBe('rejected');
    expect(cell.requests).toBe(2);
    expect(cell.days.size).toBe(2);
    expect(cell.context.merged).toBe(1);
    expect(cell.context.unknown).toBe(1);
    expect(cell.samples).toEqual(['UIREQ000000000001', 'UIREQ000000000002']);
  });
});

describe('changeRequestsBacklogItems', () => {
  it('emits per-(surface, class) items for recurring rejected and closed-unmerged requests', async () => {
    const r1 = await request('chat', 'Add a summary card');
    const r2 = await request('chat', 'Add a dark mode toggle');
    const r3 = await request('fleet', 'Add lane health inline');
    const r4 = await request('fleet', 'Add a copy button');
    const r5 = await request('fleet', 'Add a refresh control');
    await reject(r1.id, 'denied-path');
    await reject(r2.id, 'invalid-spec');
    await reject(r3.id, 'denied-path'); // single rejection on fleet: below bar
    await prState(r4.jobId, 42, 'CLOSED');
    await ingest(r4.id);
    await prState(r5.jobId, 43, 'CLOSED');
    await ingest(r5.id);

    const found = await items();
    expect(found).toHaveLength(2);
    expect(found.every((i) => i.priority === 3 && i.area === 'ui-change-requests' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(found.every((i) => validBacklogItem(i) !== null)).toBe(true);
    const chat = found.find((i) => i.title.includes('chat'))!;
    const fleet = found.find((i) => i.title.includes('fleet'))!;
    expect(chat.title).toContain('drop ingest');
    expect(chat.prompt).toContain('2 requests across 1 UTC day');
    expect(chat.prompt).toContain('UIREQ');
    // Rejection reasons are free text: counted, never quoted.
    expect(chat.prompt).not.toContain('denied-path');
    expect(chat.prompt).not.toContain('invalid-spec');
    expect(chat.prompt).toContain('change-requests.jsonl');
    expect(chat.prompt).toContain('no-change');
    expect(fleet.title).toContain('unmerged');
    expect(fleet.prompt).toContain('pull/42');
    expect(fleet.prompt).toContain('pull/43');
  });

  it('stays quiet below the recurrence bar and on non-adverse outcomes', async () => {
    const lone = await request('chat', 'One-off request');
    const merged = await request('chat', 'Merged request');
    const unknown = await request('chat', 'Evidence-free request');
    await reject(lone.id);
    await prState(merged.jobId, 43, 'MERGED');
    await ingest(unknown.id);
    // merged/unknown/ingested rows are context, not adverse: nothing emits.
    expect(await items()).toEqual([]);
  });

  it('emits nothing on a missing journal, a non-fleet repo, or junk rows', async () => {
    expect(await changeRequestsBacklogItems({ repo: 'ashlrai/phantom', statusPath: join(tempRoot, 'nope'), runsRoot })).toEqual([]);
    const r1 = await request('chat', 'Add a card');
    const r2 = await request('chat', 'Add a toggle');
    await reject(r1.id);
    await reject(r2.id);
    expect(await items({ repo: 'ashlrai/other' })).toEqual([]);
    expect(await items({ repo: '' })).toEqual([]);
    // Junk-only journal yields no rows.
    const junkDir = join(tempRoot, 'junk');
    await mkdir(junkDir, { recursive: true });
    await writeFile(join(junkDir, 'change-requests.jsonl'), 'not json\n{"v":1}\n');
    expect(await items({ statusPath: join(junkDir, 'change-requests.jsonl') })).toEqual([]);
    // Sanity: the same fixture does emit for the fleet repo.
    expect(await items()).toHaveLength(1);
  });

  it('counts malformed lines and states them in the prompt', async () => {
    const r1 = await request('chat', 'Add a card');
    const r2 = await request('chat', 'Add a toggle');
    await reject(r1.id);
    await reject(r2.id);
    const file = changeRequestStatusPath(statusRoot);
    await appendFile(file, 'not json\nstill not json\n');
    const found = await items();
    expect(found).toHaveLength(1);
    expect(found[0]!.prompt).toContain('malformed or off-contract lines dropped');
  });

  it('marks requests whose fate/PR evidence aged out as unknown, not failures', async () => {
    // No drop-fate or jobs evidence at all: rows classify unknown and never emit.
    await request('chat', 'Add a card');
    await request('chat', 'Add a toggle');
    expect(await items()).toEqual([]);
  });

  it('reads the writer-resolved changeRequestStatusPath under the relocated home when no override is given', async () => {
    // changeRequestStatusPath() resolves ~/.ashlr/router/change-requests.jsonl
    // through homedir() — $HOME-relative, not $ASHLR_HOME — matching the writer.
    const home = tempRoot;
    const dir = join(home, '.ashlr', 'router');
    await mkdir(dir, { recursive: true });
    const statusPath = join(dir, 'change-requests.jsonl');
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const r1 = await submitChangeRequest({ description: 'Add a card', surface: 'chat' }, { statusRoot: dir, now: () => NOW });
      const r2 = await submitChangeRequest({ description: 'Add a toggle', surface: 'chat' }, { statusRoot: dir, now: () => NOW });
      if (r1.status !== 'queued' || r2.status !== 'queued') throw new Error('expected queued');
      // Rejections need runsRoot evidence; point runsRoot at a fabricated root.
      const fakeRuns = join(tempRoot, 'fake-runs');
      await mkdir(join(fakeRuns, 'leader', 'drop', 'done'), { recursive: true });
      await writeFile(join(fakeRuns, 'leader', 'drop', 'done', `RQ-PHX-${r1.jobId.slice(7)}.md.denied-path`), 'x\n');
      await writeFile(join(fakeRuns, 'leader', 'drop', 'done', `RQ-PHX-${r2.jobId.slice(7)}.md.denied-path`), 'x\n');
      const found = await changeRequestsBacklogItems({ repo: 'ashlrai/phantom', runsRoot: fakeRuns });
      expect(found).toHaveLength(1);
      expect(found[0]!.title).toContain('chat');
      expect(statusPath).toContain('change-requests.jsonl');
    } finally {
      process.env.HOME = savedHome;
    }
  });

  it('honours the item limit and derives stable ids across calls', async () => {
    const a = await request('chat', 'Add a card');
    const b = await request('chat', 'Add a toggle');
    const c = await request('fleet', 'Add a button');
    const d = await request('fleet', 'Add a badge');
    await reject(a.id); await reject(b.id);
    await prState(c.jobId, 44, 'CLOSED'); await ingest(c.id);
    await prState(d.jobId, 45, 'CLOSED'); await ingest(d.id);
    const opts = { repo: 'ashlrai/phantom', statusPath: changeRequestStatusPath(statusRoot), runsRoot, now: () => NOW };
    const first = await changeRequestsBacklogItems(opts);
    const second = await changeRequestsBacklogItems(opts);
    expect(first).toHaveLength(2);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(await changeRequestsBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
    expect(CHANGE_REQUEST_TAIL_BYTES).toBeGreaterThan(0);
    expect(CHANGE_REQUEST_MIN_CELL).toBe(2);
  });
});
