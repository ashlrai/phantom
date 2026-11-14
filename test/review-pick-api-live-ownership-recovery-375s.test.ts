/** RQ-PHX-REVIEWAPIREADRECOVERY375S — desktop review-pick endpoint against
 * changing live ownership. The same createFleetWorkBoardApi →
 * createFleetReviewPickApi → readReviewPick handler answers successive
 * requests: an unowned pick, a live claimed.tsv ownership record (parsed by
 * the real parseClaimedTsv inside the collector), one failed ownership
 * source, then recovery with a new head and clock — plus an overlapping
 * timed-out request whose late settlement must not rewrite the newer
 * response. Every reader is injected synthetic evidence; nothing touches
 * the network, the process table, the real home or a real ledger. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFleetReviewPickApi, VERSE_FLEET_REVIEW_PICK_PATH as PATH } from '../src/core/verse/fleet-review-pick-api.js';
import { createFleetWorkBoardApi } from '../src/core/verse/fleet-work-board-api.js';
import { readReviewPick, REVIEW_PICK_SCHEMA, type ReviewPickReport } from '../src/core/fleet/review-pick.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import type { BusWorkClaimsInspection } from '../src/core/fleet/bus-work-claims.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const REPO = 'example/phantom';
const CLAIM_JOB = 'RQ-PHX-REVIEW-OWN-375';
const T0 = Date.parse('2026-11-14T18:00:00Z');
const T1 = Date.parse('2026-11-14T19:30:00Z');
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const UPDATED_A = '2026-11-13T00:00:00Z';
const UPDATED_B = '2026-11-14T12:00:00Z';
const API_TIMEOUT_MS = 50;
const REPORT_KEYS = ['as_of', 'picked', 'reason', 'repo', 'schema', 'skipped', 'source', 'unowned_candidates'];

interface GhResult { ok: boolean; stdout: string; stderr: string }

interface World {
  now: number;
  head: string;
  updatedAt: string;
  claimedText: string;
  boardState: FleetBoard['state'];
  boardClaims: FleetBoard['claims'];
  busSource: BusWorkClaimsInspection['source'];
  workersState: LiveWorkersSnapshot['sourceState'];
  hangGh: boolean;
  ghRelease: ((result: GhResult) => void) | null;
  readTimeoutMs: number;
}

function prRow(world: World): Record<string, unknown> {
  return {
    number: 101, title: `Review pick api live ownership ${CLAIM_JOB}`,
    headRefName: 'bridge/review-api-375s', headRefOid: world.head, isDraft: false,
    mergeStateStatus: 'CLEAN', updatedAt: world.updatedAt,
  };
}

function ghStdout(world: World): string {
  return JSON.stringify([prRow(world)]);
}

/** One mutable synthetic world behind the real collector; the API handler
 * instance is reused for every request. */
async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'review-pick-375s-'));
  const world: World = {
    now: T0, head: HEAD_A, updatedAt: UPDATED_A, claimedText: '',
    boardState: 'known', boardClaims: [], busSource: 'available', workersState: 'healthy',
    hangGh: false, ghRelease: null, readTimeoutMs: 5_000,
  };
  const gh = vi.fn<CloudGh>(async () => {
    if (world.hangGh) {
      return new Promise<GhResult>(resolve => { world.ghRelease = resolve; });
    }
    return { ok: true, stdout: ghStdout(world), stderr: '' };
  });
  const readClaimedTsv = vi.fn(async () => ({ state: 'healthy' as const, text: world.claimedText }));
  const inspectBusWork = vi.fn((): BusWorkClaimsInspection => ({ source: world.busSource, claims: [] }));
  const readBoard = vi.fn((): FleetBoard => ({
    schema: 'fleet.coordination.v1', state: world.boardState, claims: world.boardClaims,
    messages: [], proposals: [], expiredClaims: world.boardState === 'known' ? 0 : null,
  }));
  const listWorkers = vi.fn(async (): Promise<LiveWorkersSnapshot> => ({
    v: 1, generatedAt: new Date(world.now).toISOString(), sourceState: world.workersState,
    workers: [], leaders: [], orchestratorAgents: 0,
  }));
  const orders = vi.fn<ApiModule>(async () => false);
  const postReply = vi.fn(() => { throw new Error('review-pick must never post'); });
  const boardRead = vi.fn(() => { throw new Error('board path must not read'); });
  const read = (opts: { repo: string }): Promise<ReviewPickReport> => readReviewPick({
    repo: opts.repo, runsDir: scratch, gh, readClaimedTsv, inspectBusWork, readBoard, listWorkers,
    now: () => world.now, readTimeoutMs: world.readTimeoutMs,
  });
  const api = createFleetWorkBoardApi({
    reviewPick: createFleetReviewPickApi({ read, timeoutMs: API_TIMEOUT_MS }),
    orders, postReply, read: boardRead,
  });
  return { api, world, scratch, gh, readClaimedTsv, inspectBusWork, readBoard, listWorkers, orders, postReply, boardRead };
}

async function call(api: ApiModule, url = `${PATH}?repo=${REPO}`, method = 'GET') {
  let status = 0;
  let text = '';
  const end = vi.fn((body: string) => { text = body; });
  const res = { writeHead(code: number) { status = code; return this; }, end } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, { url } as IncomingMessage, res, url.split('?')[0]!, method);
  expect(text).not.toMatch(/\/Users\/|\/(?:tmp|private|etc|opt|var|home)\//);
  return { handled, status, text, body: text ? JSON.parse(text) as ReviewPickReport : null, end };
}

function expectReportShape(body: ReviewPickReport): void {
  expect(body.schema).toBe(REVIEW_PICK_SCHEMA);
  expect(Object.keys(body).sort()).toEqual([...REPORT_KEYS].sort());
  expect(body.repo).toBe(REPO);
  expect(typeof body.as_of).toBe('string');
  expect(Array.isArray(body.skipped)).toBe(true);
}

function expectAllSourcesRead(body: ReviewPickReport): void {
  expect(body.source.prs).toBe('read');
  expect(body.source.claims).toEqual({
    'claimed-tsv': 'read', 'bus-work-claims': 'read', coordination: 'read', 'live-workers': 'read',
  });
  expect(body.source.unavailable).toEqual([]);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('review-pick api live ownership recovery', () => {
  it('re-reads ownership, head and clock on every request through one handler', async () => {
    const f = await fixture();
    cleanups.push(() => rm(f.scratch, { recursive: true, force: true }));

    // 1. Healthy PR + healthy sources: the collector picks the unowned PR.
    const first = await call(f.api);
    expect(first.handled).toBe(true);
    expect(first.status).toBe(200);
    const firstBody = first.body!;
    expectReportShape(firstBody);
    expectAllSourcesRead(firstBody);
    expect(firstBody.as_of).toBe(new Date(T0).toISOString());
    expect(firstBody.picked).toMatchObject({
      repo: REPO, pr: 101, head: 'bridge/review-api-375s', head_sha: HEAD_A,
      title: `Review pick api live ownership ${CLAIM_JOB}`, owner: 'none',
    });
    expect(firstBody.reason).toContain('no live claim or running worker');
    expect(firstBody.skipped).toEqual([]);
    expect(firstBody.unowned_candidates).toBe(1);
    expect(f.gh).toHaveBeenCalledTimes(1);
    expect(f.gh.mock.calls[0]![0].slice(0, 4)).toEqual(['pr', 'list', '--repo', REPO]);

    // 2. A real claimed.tsv row naming the PR's RQ id: the same handler now
    // reports picked:null with the collector's owner-exclusion evidence.
    f.world.claimedText = `${CLAIM_JOB}\tdevin\tfast\t18:00\t${Math.floor(T0 / 1000)}\n`;
    const owned = await call(f.api);
    expect(owned.status).toBe(200);
    const ownedBody = owned.body!;
    expectReportShape(ownedBody);
    expectAllSourcesRead(ownedBody);
    expect(ownedBody.as_of).toBe(new Date(T0).toISOString());
    expect(ownedBody.picked).toBeNull();
    expect(ownedBody.reason).toBe('no unowned non-draft open PRs');
    expect(ownedBody.unowned_candidates).toBe(0);
    expect(ownedBody.skipped).toEqual([{
      pr: 101, owner: 'devin', why: `live claim '${CLAIM_JOB}' via claimed-tsv`,
    }]);
    expect(owned.text).not.toContain('"owner":"none"');

    // 3. One ownership source fails: fail-closed, no pick is invented.
    f.world.boardState = 'unknown';
    const degraded = await call(f.api);
    expect(degraded.status).toBe(200);
    const degradedBody = degraded.body!;
    expectReportShape(degradedBody);
    expect(degradedBody.source.prs).toBe('read');
    expect(degradedBody.source.claims['claimed-tsv']).toBe('read');
    expect(degradedBody.source.claims.coordination).toBe('unavailable');
    expect(degradedBody.source.claims['bus-work-claims']).toBe('read');
    expect(degradedBody.source.claims['live-workers']).toBe('read');
    expect(degradedBody.source.unavailable).toEqual(['coordination']);
    expect(degradedBody.picked).toBeNull();
    expect(degradedBody.reason).toBe('ownership source unavailable');

    // 4. Evidence recovers, ownership is gone, the PR head and clock moved:
    // the same handler returns the fresh pick, not a cached answer.
    f.world.boardState = 'known';
    f.world.claimedText = '';
    f.world.head = HEAD_B;
    f.world.updatedAt = UPDATED_B;
    f.world.now = T1;
    const recovered = await call(f.api);
    expect(recovered.status).toBe(200);
    const recoveredBody = recovered.body!;
    expectReportShape(recoveredBody);
    expectAllSourcesRead(recoveredBody);
    expect(recoveredBody.as_of).toBe(new Date(T1).toISOString());
    expect(recoveredBody.picked).toMatchObject({
      repo: REPO, pr: 101, head: 'bridge/review-api-375s', head_sha: HEAD_B, owner: 'none',
    });
    expect(recoveredBody.unowned_candidates).toBe(1);
    expect(recoveredBody.skipped).toEqual([]);
    expect(recovered.text).not.toContain(HEAD_A);

    // Read-only contract: every gh call was `pr list`, every ownership reader
    // was invoked per request, nothing posted, enqueued or claimed, and the
    // scratch runs dir stayed empty.
    expect(f.gh).toHaveBeenCalledTimes(4);
    for (const args of f.gh.mock.calls) expect(args[0].slice(0, 2)).toEqual(['pr', 'list']);
    for (const reader of [f.readClaimedTsv, f.inspectBusWork, f.readBoard, f.listWorkers]) {
      expect(reader).toHaveBeenCalledTimes(4);
    }
    expect(f.orders).not.toHaveBeenCalled();
    expect(f.postReply).not.toHaveBeenCalled();
    expect(f.boardRead).not.toHaveBeenCalled();
    expect(await readdir(f.scratch)).toEqual([]);
  });

  it('keeps the timed-out answer when the older read settles late', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    cleanups.push(() => rm(f.scratch, { recursive: true, force: true }));
    f.world.hangGh = true;
    f.world.readTimeoutMs = 60_000;

    // Request A hangs inside the collector past the API deadline.
    const pendingA = call(f.api);
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS);
    const a = await pendingA;
    expect(a.status).toBe(200);
    expect(a.end).toHaveBeenCalledTimes(1);
    expect(a.body).toMatchObject({
      schema: REVIEW_PICK_SCHEMA, repo: REPO, picked: null,
      reason: 'review-pick read unavailable',
      source: { prs: 'unavailable', unavailable: ['claimed-tsv', 'bus-work-claims', 'coordination', 'live-workers'] },
    });
    const aText = a.text;

    // Request B on the same handler answers healthy while A is still pending.
    f.world.hangGh = false;
    f.world.head = HEAD_B;
    f.world.now = T1;
    const b = await call(f.api);
    expect(b.status).toBe(200);
    expect(b.end).toHaveBeenCalledTimes(1);
    expect(b.body!.picked).toMatchObject({ repo: REPO, pr: 101, head_sha: HEAD_B, owner: 'none' });
    expect(b.body!.as_of).toBe(new Date(T1).toISOString());

    // A's gh read settles late: it must not replace A's sent answer, touch
    // B's response, or leave a timer behind.
    expect(f.world.ghRelease).not.toBeNull();
    f.world.ghRelease!({ ok: true, stdout: ghStdout(f.world), stderr: '' });
    await vi.runAllTimersAsync();
    expect(a.end).toHaveBeenCalledTimes(1);
    expect(a.text).toBe(aText);
    expect(b.end).toHaveBeenCalledTimes(1);
    expect(b.body!.picked).toMatchObject({ head_sha: HEAD_B });
    expect(vi.getTimerCount()).toBe(0);
  });
});
