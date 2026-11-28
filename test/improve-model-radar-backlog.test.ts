import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MODEL_RADAR_BACKLOG_MAX_ITEMS,
  MODEL_RADAR_TITLE_PREFIX,
  modelRadarBacklogItems,
} from '../src/core/improve/model-radar-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = await mkdtemp(join(tmpdir(), 'improve-modelradar-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const inboxDir = (): string => join(home, '.ashlr', 'inbox');

/** The writer's summary shape from fileModelRadarProposals, with the patch marker intact. */
const PATCH = '{"schema":"models.registry-patch.v1","version":1,"applied":false,"add":[{"id":"claude-opus-6","provider":"anthropic","verified_source":null,"verified_at":null,"status":"unverified"}],"retire":[],"rename":[]}';

const noteSummary = (over: { source?: string; retrieved?: string; line?: number; evidence?: string } = {}): string => [
  'Review this official-source candidate for Phantom\'s docs/model-registry.json. A shape match is not verification; the row stays unverified.',
  `Source: ${over.source ?? 'https://platform.claude.com/docs/en/models/opus-6/overview'} (retrieved ${over.retrieved ?? '2026-11-20'}, line ${over.line ?? 42})`,
  `Evidence (quoted): ${JSON.stringify(over.evidence ?? 'claude-opus-6 is now available')}`,
  `Unapplied registry patch: ${PATCH}`,
].join('\n');

interface NoteOpts {
  id?: string;
  title?: string;
  summary?: string;
  createdAt?: string;
  status?: string;
  origin?: string;
  kind?: string;
  repo?: unknown;
}

let noteSeq = 0;
const writeNote = async (opts: NoteOpts = {}): Promise<string> => {
  const id = opts.id ?? `note-radar-${(noteSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const body = {
    id,
    origin: opts.origin ?? 'manual',
    kind: opts.kind ?? 'note',
    title: opts.title ?? `${MODEL_RADAR_TITLE_PREFIX}anthropic:claude-opus-6`,
    summary: opts.summary ?? noteSummary(),
    status: opts.status ?? 'pending',
    createdAt: opts.createdAt ?? '2026-11-20T03:47:00.000Z',
    repo: opts.repo === undefined ? null : opts.repo,
  };
  await mkdir(inboxDir(), { recursive: true });
  await writeFile(join(inboxDir(), `${id}.json`), `${JSON.stringify(body, null, 2)}\n`);
  return id;
};

const staleNote = (candidate = 'anthropic:claude-opus-6', createdAt = '2026-11-20T03:47:00.000Z'): Promise<string> =>
  writeNote({ title: `${MODEL_RADAR_TITLE_PREFIX}${candidate}`, createdAt });

describe('modelRadarBacklogItems', () => {
  it('emits one item per candidate pending past the grace, with stable ids and honest metadata', async () => {
    const id1 = await staleNote('anthropic:claude-opus-6', '2026-11-18T03:47:00.000Z');
    await staleNote('openai:gpt-6.1-codex', '2026-11-19T03:47:00.000Z');
    const items = await modelRadarBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(items.every((i) => /^modelradar-[0-9a-f]{12}$/.test(i.id))).toBe(true);
    expect(items.every((i) => i.priority === 3 && i.area === 'router-catalog' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);

    // Oldest pending first.
    expect(items[0]!.title).toContain('anthropic:claude-opus-6');
    expect(items[1]!.title).toContain('openai:gpt-6.1-codex');

    const first = items[0]!;
    expect(first.prompt).toContain('anthropic:claude-opus-6');
    expect(first.prompt).toContain(id1);
    expect(first.prompt).toContain('platform.claude.com');
    expect(first.prompt).toContain('2026-11-18T03:47:00.000Z');
    expect(first.prompt).toContain('docs/model-registry.json');
    expect(first.prompt).toContain('phm inbox show');
    expect(first.prompt).toContain('no-change');
    expect(first.doneWhen).toEqual({ path: 'docs/model-registry.json', contains: '"id": "claude-opus-6"' });

    expect(items.length).toBeLessThanOrEqual(Math.min(MODEL_RADAR_BACKLOG_MAX_ITEMS, 25));
    const limited = await modelRadarBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS), limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.id).toBe(first.id);
  });

  it('stays quiet below the grace, on decided or foreign notes, and on missing inbox', async () => {
    // Fresh note inside the default grace.
    await staleNote('anthropic:claude-opus-6', '2026-11-30T03:47:00.000Z');
    expect(await modelRadarBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toEqual([]);
    // A custom grace admits it — the opt exists for tests and tuning.
    const admitted = await modelRadarBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS), graceMs: DAY_MS });
    expect(admitted).toHaveLength(1);

    // Decided statuses never count.
    for (const status of ['approved', 'rejected', 'applied', 'failed', 'awaiting-host-merge']) {
      await rm(inboxDir(), { recursive: true, force: true });
      await writeNote({ status, createdAt: '2026-11-01T00:00:00.000Z' });
      expect(await modelRadarBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toEqual([]);
    }

    // Off-contract shapes never count: wrong origin/kind, repo-scoped, no prefix, no patch marker, bad or future stamps.
    const canonicalRepo = realpathSync(home);
    const bad: NoteOpts[] = [
      { origin: 'agent' }, { origin: 'backlog' }, { origin: 'swarm' },
      { kind: 'pr' }, { kind: 'patch' },
      { repo: canonicalRepo },
      { title: 'Review anthropic:claude-opus-6' },
      { title: `${MODEL_RADAR_TITLE_PREFIX}anthropic:claude opus 6` },
      { title: `${MODEL_RADAR_TITLE_PREFIX}nocolon` },
      { summary: 'no patch marker here' },
      { createdAt: 'not-a-date' },
      { createdAt: '2026-12-01T12:05:00.000Z' }, // 5 minutes ahead — past the skew
    ];
    for (const opts of bad) {
      await rm(inboxDir(), { recursive: true, force: true });
      await writeNote({ createdAt: '2026-11-01T00:00:00.000Z', ...opts });
      expect(await modelRadarBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toEqual([]);
    }

    // Missing inbox dir entirely.
    await rm(inboxDir(), { recursive: true, force: true });
    await rm(join(home, '.ashlr'), { recursive: true, force: true });
    expect(await modelRadarBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toEqual([]);
  });

  it('reads only pending writer-contract notes and groups same-candidate stragglers', async () => {
    // Two pending notes naming the same candidate fold into one cell.
    const idA = await staleNote('anthropic:claude-opus-6', '2026-11-18T03:47:00.000Z');
    const idB = await staleNote('anthropic:claude-opus-6', '2026-11-22T03:47:00.000Z');
    // A decided twin of another candidate does not count.
    await writeNote({ title: `${MODEL_RADAR_TITLE_PREFIX}zai:glm-5.4`, status: 'rejected', createdAt: '2026-11-01T00:00:00.000Z' });
    // A manual note imitating the prefix without the patch marker does not count.
    await writeNote({ title: `${MODEL_RADAR_TITLE_PREFIX}evil:fake-1`, summary: 'just a note', createdAt: '2026-11-01T00:00:00.000Z' });
    // A non-radar pending note does not count.
    await writeNote({ title: 'Please review the deploy window', summary: 'unrelated', createdAt: '2026-11-01T00:00:00.000Z' });

    const items = await modelRadarBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('Pending inbox notes');
    expect(items[0]!.prompt).toContain(idA);
    expect(items[0]!.prompt).toContain(idB);
    expect(items[0]!.prompt).toContain('2026-11-18T03:47:00.000Z');
  });

  it('a malformed proposal file degrades the whole read to no items; stray non-json files are ignored', async () => {
    await staleNote('anthropic:claude-opus-6', '2026-11-18T03:47:00.000Z');
    await writeFile(join(inboxDir(), 'broken.json'), '{not json');
    expect(await modelRadarBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toEqual([]);

    await rm(join(inboxDir(), 'broken.json'));
    await writeFile(join(inboxDir(), 'notes.txt'), 'not a proposal');
    const items = await modelRadarBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
  });

  it('emits only for the fleet repository, case-insensitive on the last segment', async () => {
    await staleNote('anthropic:claude-opus-6', '2026-11-18T03:47:00.000Z');
    const opts = { now: new Date(NOW_MS) };
    expect(await modelRadarBacklogItems({ repo: 'ashlrai/other', ...opts })).toEqual([]);
    expect(await modelRadarBacklogItems({ repo: 'ashlrai/phantom-extra', ...opts })).toEqual([]);
    expect(await modelRadarBacklogItems({ repo: 'phantom', ...opts })).toHaveLength(1);
    expect(await modelRadarBacklogItems({ repo: 'AshlrAI/Phantom', ...opts })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing, scrubs quoted fields and honors the item cap', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    await writeNote({
      title: `${MODEL_RADAR_TITLE_PREFIX}anthropic:claude-opus-6`,
      summary: noteSummary({ source: `https://platform.claude.com/docs?q=${token}`, evidence: `saw ${token}` }),
      createdAt: '2026-11-18T03:47:00.000Z',
    });
    const opts = { repo: 'ashlrai/phantom', now: new Date(NOW_MS) };
    const first = await modelRadarBacklogItems(opts);
    const second = await modelRadarBacklogItems(opts);
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first[0]!.prompt).not.toContain(token);
    expect(first[0]!.prompt).toContain('[REDACTED]');

    // The cap bounds a pathological inbox: 10 stale candidates, default limit,
    // oldest pending first (claude-opus-0 filed 2026-11-10 is the oldest).
    await rm(inboxDir(), { recursive: true, force: true });
    for (let i = 0; i < 10; i++) {
      await staleNote(`anthropic:claude-opus-${i}`, `2026-11-${String(10 + i).padStart(2, '0')}T03:47:00.000Z`);
    }
    const capped = await modelRadarBacklogItems(opts);
    expect(capped).toHaveLength(MODEL_RADAR_BACKLOG_MAX_ITEMS);
    expect(capped[0]!.title).toContain('claude-opus-0');
    expect(capped[capped.length - 1]!.title).toContain('claude-opus-7');
  });

  it('appends model-radar items through discovery and dedupes on refresh', async () => {
    await staleNote('anthropic:claude-opus-6', '2026-11-18T03:47:00.000Z');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const radarItems = first.items.filter((i) => i.id.startsWith('modelradar-'));
    expect(radarItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(radarItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('modelradar-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('modelradar-'))).toHaveLength(1);
  });
});
