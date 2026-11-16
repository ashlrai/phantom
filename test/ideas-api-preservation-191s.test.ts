/**
 * RQ-PHX-IDEASAPIPRESERVE191S — preservation of the real-router Ideas draft
 * acceptance coverage from original Phantom PR #4910. Source suite:
 * afba1b3163ae2cc93bf70405a3cfc58950d80418:
 *   test/ideas-draft-original-4348-api-10srs1.test.ts
 * (itself recovered from #4348, source commit 694118b2), absent on master.
 *
 * POST /api/ideas/draft exercised through the REAL mount:
 * handleApi → isIdeasDraftPath → handleIdeasDraftApi → draftIdeas →
 * writeDropJob, against a scratch HOME (backlog.json) and a scratch
 * ASHLR_RUNS_DIR. No deps injection on this path — env is the seam.
 * test/ideas-draft-route.test.ts and test/ideas-draft-route-s136.test.ts
 * cover draftIdeas with injected deps; test/ideas-draft.recut-c151.test.ts
 * covers only the bare 404 dispatch. This file keeps the mounted-path
 * assertions those suites cannot prove:
 *
 *   dispatch off        → 404, zero filesystem changes
 *   bad/missing token   → 401, zero filesystem changes
 *   non-JSON content    → 415; oversize body → 400
 *   1..8 known ids      → 200 {draftId, written, existing}; deterministic,
 *                         order-independent id; repeat returns existing
 *                         without a second write
 *   queued overlap      → advisory collisions hold the write until
 *                         confirmCollisions: true
 *   >8 / empty / unknown→ 400 / 400 / 404
 *   backlog text        → scrubbed before it reaches the drop file
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleApi } from '../src/core/web/api.js';
import { IDEAS_DRAFT_PATH, ideasDraftId } from '../src/core/web/ideas-draft-route.js';
import type { AshlrConfig } from '../src/core/types.js';

const TOKEN = randomUUID();
const DROP_DIR = join('leader', 'drop', 'claude');

let home: string;
let runs: string;

const items = Array.from({ length: 10 }, (_, i) => ({
  id: `idea-${i}`,
  repo: '/work/phantom',
  source: 'issue',
  title: `Fix thing ${i}`,
  detail: `Why ${i}: src/core/thing${i}.ts is wrong`,
  score: 90 - i,
}));

async function writeBacklog(extra: Record<string, unknown>[] = []): Promise<void> {
  await mkdir(join(home, '.ashlr'), { recursive: true });
  await writeFile(
    join(home, '.ashlr', 'backlog.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      repos: ['/work/phantom'],
      items: [...items, ...extra],
    }),
  );
}

interface ApiResult { handled: boolean; status: number; json: Record<string, unknown> }

async function post(
  payload: unknown,
  options: { allowDispatch?: boolean; token?: string | null; contentType?: string; raw?: string; method?: string } = {},
): Promise<ApiResult> {
  const body = options.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': options.contentType ?? 'application/json' };
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers['x-ashlr-token'] = token;
  const req = Readable.from([body]) as IncomingMessage;
  req.url = IDEAS_DRAFT_PATH;
  req.method = options.method ?? 'POST';
  req.headers = headers;
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; },
    end(value: string) { text = value; },
  } as unknown as ServerResponse;
  const handled = await handleApi(req, res, {} as AshlrConfig, {
    allowDispatch: options.allowDispatch ?? true,
    token: TOKEN,
  });
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { handled, status, json };
}

const dropFiles = () => readdir(join(runs, DROP_DIR)).catch(() => [] as string[]);
const dropText = async (draftId: string) =>
  readFile(join(runs, DROP_DIR, `RQ-PHX-${draftId}.md`), 'utf8');

/** Every path under the scratch runs root — must stay empty on refusals. */
async function runsTree(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, name.name);
      if (name.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(runs);
  return out;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'ideas-api-home-'));
  runs = await mkdtemp(join(tmpdir(), 'ideas-api-runs-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  await writeBacklog();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
  await rm(runs, { recursive: true, force: true });
});

describe('POST /api/ideas/draft mounted through handleApi', () => {
  it('refuses when dispatch is off, with no filesystem changes', async () => {
    const res = await post({ ideaIds: ['idea-1'] }, { allowDispatch: false });
    expect(res.handled).toBe(true);
    expect(res.status).toBe(404);
    expect(await runsTree()).toEqual([]);
    expect(await dropFiles()).toEqual([]);
  });

  it('refuses a missing or wrong token and a non-JSON content type, with no filesystem changes', async () => {
    expect((await post({ ideaIds: ['idea-1'] }, { token: null })).status).toBe(401);
    expect((await post({ ideaIds: ['idea-1'] }, { token: 'wrong' })).status).toBe(401);
    expect((await post({ ideaIds: ['idea-1'] }, { contentType: 'text/plain' })).status).toBe(415);
    expect((await post({ ideaIds: ['idea-1'] }, { method: 'GET' })).status).toBe(404);
    expect(await runsTree()).toEqual([]);
  });

  it('bounds the JSON body', async () => {
    const res = await post(null, { raw: `{"ideaIds":["idea-1"],"pad":"${'x'.repeat(20 * 1024)}"}` });
    expect(res.status).toBe(400);
    expect(await dropFiles()).toEqual([]);
  });

  it('writes one draft for a single known idea and asserts its content and id', async () => {
    const res = await post({ ideaIds: ['idea-1'] });
    expect(res.status).toBe(200);
    expect(res.json['draftId']).toBe(ideasDraftId(['idea-1']));
    expect(res.json['written']).toBe(true);
    expect(res.json['existing']).toBe(false);
    expect(res.json['collisions']).toEqual([]);

    const files = await dropFiles();
    expect(files).toEqual([`RQ-PHX-${ideasDraftId(['idea-1'])}.md`]);
    const text = await dropText(ideasDraftId(['idea-1']));
    expect(text.split('\n')[0]).toBe('#job repo=phantom lane=claude tier=work');
    expect(text).toContain('Fix thing 1');
    expect(text).toContain('idea idea-1');
    expect(text).toContain('Source: issue');
    expect(text).toContain('src/core/thing1.ts');
  });

  it('returns the same draft for a reordered repeat without another write', async () => {
    const ids = ['idea-0', 'idea-1', 'idea-2'];
    const first = await post({ ideaIds: ids });
    expect(first.status).toBe(200);
    expect(first.json['draftId']).toBe(ideasDraftId(ids));
    expect(first.json['written']).toBe(true);

    const again = await post({ ideaIds: [...ids].reverse(), confirmCollisions: false });
    expect(again.status).toBe(200);
    expect(again.json['draftId']).toBe(first.json['draftId']);
    expect(again.json['written']).toBe(false);
    expect(again.json['existing']).toBe(true);
    expect(await dropFiles()).toHaveLength(1);
  });

  it('batches 1-8 unique known ideas into one file naming each source idea', async () => {
    const ids = items.slice(0, 8).map(i => i.id);
    const res = await post({ ideaIds: ids });
    expect(res.status).toBe(200);
    expect(res.json['draftId']).toBe(ideasDraftId(ids));
    expect(await dropFiles()).toHaveLength(1);
    const text = await dropText(String(res.json['draftId']));
    for (const i of ids) expect(text).toContain(`idea ${i}`);
    expect(text).toContain('deliver these related ideas together');
  });

  it('refuses out-of-range, empty and unknown idea sets', async () => {
    const nine = items.slice(0, 9).map(i => i.id);
    expect((await post({ ideaIds: nine })).status).toBe(400);
    expect((await post({ ideaIds: [] })).status).toBe(400);
    expect((await post({ ideaIds: ['nope'] })).status).toBe(404);
    expect((await post({ ideaIds: 'idea-1' })).status).toBe(400);
    expect((await post({ ideaIds: ['idea-1'], extra: true })).status).toBe(400);
    expect(await dropFiles()).toEqual([]);
  });

  it('holds a colliding draft until confirmCollisions, then writes it once', async () => {
    await mkdir(join(runs, 'queue', 'prompts'), { recursive: true });
    await writeFile(
      join(runs, 'queue', 'prompts', 'RQ-PHX-OTHER.md'),
      '#job repo=phantom lane=claude tier=work\n\nTouch src/core/thing1.ts please.\n',
    );
    const held = await post({ ideaIds: ['idea-1'] });
    expect(held.status).toBe(200);
    expect(held.json['written']).toBe(false);
    expect(held.json['existing']).toBe(false);
    expect(held.json['collisions']).toEqual([
      { path: 'src/core/thing1.ts', draft: `RQ-PHX-${ideasDraftId(['idea-1'])}.md`, queued: ['RQ-PHX-OTHER'] },
    ]);
    expect(await dropFiles()).toEqual([]);

    const confirmed = await post({ ideaIds: ['idea-1'], confirmCollisions: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json['draftId']).toBe(held.json['draftId']);
    expect(confirmed.json['written']).toBe(true);
    expect(confirmed.json['collisions']).toEqual(held.json['collisions']);
    expect(await dropFiles()).toEqual([`RQ-PHX-${ideasDraftId(['idea-1'])}.md`]);
  });

  it('scrubs secret-shaped backlog text before it reaches the drop file', async () => {
    const secret = randomBytes(32).toString('hex');
    await writeBacklog([{ ...items[0]!, id: 'idea-secret', detail: `rotate ${secret} in src/core/thing0.ts` }]);
    const res = await post({ ideaIds: ['idea-secret'] });
    expect(res.status).toBe(200);
    const text = await dropText(String(res.json['draftId']));
    expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('idea idea-secret');
    expect(text).toContain('Source: issue');
  });
});
