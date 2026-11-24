import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { LeaderBriefV1 } from '../src/core/fleet/leader-job-brief.js';
import { createOwnerThreadApi, VERSE_LEADER_BRIEF_PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const FIXTURE: LeaderBriefV1 = {
  schema: 'leader.brief.v1', version: 1, generated_at: '2026-11-20T08:00:00.000Z', window_hours: 24,
  jobs: { known: true, reason: null, rows: [
    { id: 'RQ-GIFTOPENN21SQ8', result: 'published', pr_state: 'open', pr_url: 'https://example.test/pr/1', gap: null, reason: null, at: '2026-11-20T07:00:00.000Z' },
    { id: 'RQ-EDGEN21QQ8', result: 'no_change', pr_state: null, pr_url: null, gap: 'nothing left to cut', reason: null, at: null },
  ] },
  lanes: { known: true, reason: null, rows: [{ lane: 'claude', running: 1, target: 8, queued: 0, held: false }] },
  admission: { known: true, reason: null, state: 'closed', why: 'closed at the global cap (8 of 8 running)' },
  pools: { known: true, reason: null, rows: [{ id: 'claude', used_pct: 40, hours_to_reset: 3, waste_risk: 'low', verdict: 'fine' }] },
  gaps: { known: true, reason: null, total: 0, top: [] },
  summary: 'Last 24h: 1 published.',
};

async function call(path = VERSE_LEADER_BRIEF_PATH, method = 'GET', allowDispatch = true, jobBrief = async () => FIXTURE) {
  const dir = mkdtempSync(join(tmpdir(), 'leader-brief-api-'));
  try {
    let status = 0, text = '';
    const req = Object.assign(new PassThrough(), { url: path, method }) as IncomingMessage;
    const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
    const read = vi.fn(jobBrief);
    const api = createOwnerThreadApi({ runsDir: dir, configDir: dir, jobBrief: read, now: () => 0 });
    const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, path, method);
    return { handled, status, body: JSON.parse(text), read };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('leader brief API', () => {
  it('serves the typed brief unchanged', async () => {
    const r = await call();
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(FIXTURE);
  });
  it('requires dispatch authority', async () => {
    const r = await call(undefined, 'GET', false);
    expect(r.status).toBe(404);
    expect(r.read).not.toHaveBeenCalled();
  });
  it('rejects POST', async () => { expect((await call(undefined, 'POST')).status).toBe(405); });
  it('says unavailable when the read throws', async () => {
    const r = await call(undefined, 'GET', true, async () => { throw new Error('failed'); });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ schema: 'leader.brief.v1', unavailable: true });
  });
});
