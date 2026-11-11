/**
 * POST /api/verse/goals — the desktop Goals pane's write (RQ-PHX-GOALADDDESK92).
 * Hermetic: HOME is a tmp dir so the real ~/.ashlr is never touched; the only
 * write the route may reach is goals/store.ts createGoalIfAbsent.
 *
 * Covers: created then exists on the deterministic id (and the cfg owner
 * stamp); the objective limits `ashlr goals add` shares — empty, oversized,
 * control characters — plus the strict body; the shared Verse mutation guard
 * (404 without dispatch, 401 on a bad token, 415 without JSON, 413 over the
 * body cap, 400 on bad JSON); a store 'failed' or throw as a 500 sentence
 * with no stack; and 405 on every other verb.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoalsCreateApi, handleGoalsCreateApi, VERSE_GOALS_PATH as PATH } from '../src/core/verse/goals-create-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { CreateGoalIfAbsentResult } from '../src/core/goals/store.js';
import type { Goal } from '../src/core/types.js';

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-verse-goals-'));
  process.env.HOME = tmpHome;
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

interface CallOptions {
  token?: string;
  contentType?: string;
  allowDispatch?: boolean;
  url?: string;
  raw?: string;
}

async function call(method: string, body?: unknown, opts: CallOptions = {}, api: ApiModule = handleGoalsCreateApi) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  const url = opts.url ?? PATH;
  Object.assign(req, {
    method,
    url,
    headers: {
      'content-type': opts.contentType ?? 'application/json',
      'x-ashlr-token': opts.token ?? 'fixture-token',
    },
  });
  req.end(opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  let status = 0, text = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { text = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { cfg: { user: { id: 'mason@ashlr.ai' } }, token: 'fixture-token', allowDispatch: opts.allowDispatch ?? true } as unknown as VerseApiContext;
  const handled = await api(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, text, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

describe('POST /api/verse/goals', () => {
  it('creates then reports exists for the same objective, persisting under ~/.ashlr/goals', async () => {
    const first = await call('POST', { objective: '  Ship the desktop release  ' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ schema: 'verse.goal-create.v1', status: 'created' });
    const goal = first.body!['goal'] as { id: string; objective: string; status: string };
    expect(goal.objective).toBe('Ship the desktop release');
    expect(goal.status).toBe('planning');
    expect(goal.id.length).toBeGreaterThan(0);

    const file = join(tmpHome, '.ashlr', 'goals', `${goal.id}.json`);
    expect(existsSync(file)).toBe(true);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { owner?: string }).owner).toBe('mason@ashlr.ai');

    const again = await call('POST', { objective: 'Ship the desktop release' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ schema: 'verse.goal-create.v1', status: 'exists', goal: { id: goal.id } });
  });

  it('400s on empty, oversized, control-character, non-string and off-contract objectives', async () => {
    for (const body of [
      {},
      { objective: '' },
      { objective: '   ' },
      { objective: 'x'.repeat(4_001) },
      { objective: 'bad\nline' },
      { objective: 'tab\there' },
      { objective: `nul${String.fromCharCode(0)}byte` },
      { objective: 42 },
      { objective: 'ok', project: '/tmp/repo' },
      'just text',
      [1, 2],
    ]) {
      expect((await call('POST', body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await call('POST', { objective: 'x'.repeat(4_000) })).status).toBe(200);
  });

  it('runs the shared Verse mutation guard before any store touch', async () => {
    const body = { objective: 'anything' };
    expect((await call('POST', body, { allowDispatch: false })).status).toBe(404);
    expect((await call('POST', body, { token: '' })).status).toBe(401);
    expect((await call('POST', body, { token: 'wrong' })).status).toBe(401);
    expect((await call('POST', body, { contentType: 'text/plain' })).status).toBe(415);
    expect((await call('POST', undefined, { raw: '{not json' })).status).toBe(400);
    expect((await call('POST', undefined, { raw: `"a string"` })).status).toBe(400);
    expect((await call('POST', undefined, { raw: ' '.repeat(70_000) })).status).toBe(413);
  });

  it('answers a store failure as a 500 sentence, never a stack or a path', async () => {
    const goal: Goal = {
      id: 'unwritten', objective: 'x', project: null, status: 'planning',
      milestones: [], createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    };
    const failed = createGoalsCreateApi({ create: (): CreateGoalIfAbsentResult => ({ status: 'failed', goal }) });
    expect((await call('POST', { objective: 'x' }, {}, failed)).status).toBe(500);

    const thrown = createGoalsCreateApi({
      create: () => { throw new Error(`EIO writing ${join(tmpHome, 'secret')}\n    at somewhere (file.ts:1:1)`); },
    });
    const r = await call('POST', { objective: 'x' }, {}, thrown);
    expect(r.status).toBe(500);
    expect(r.body!['error']).toBe('the goal could not be saved.');
    expect(r.text).not.toContain('EIO');
    expect(r.text).not.toContain('secret');
    expect(r.text).not.toContain(tmpHome);
    expect(r.text).not.toContain('file.ts');
  });

  it('405s on other verbs and declines other paths', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      expect((await call(method)).status).toBe(405);
    }
    expect((await call('POST', { objective: 'x' }, { url: '/api/verse/other' })).handled).toBe(false);
  });
});
