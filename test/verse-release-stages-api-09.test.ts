import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ReleaseRunner } from '../src/core/fleet/release-live-notice.js';
import { createReleaseStagesApi, VERSE_RELEASE_STAGES_PATH as PATH } from '../src/core/verse/release-stages-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = new Date('2026-11-09T12:00:00Z');
const TAG = 'v3.30.8';
const names = (v: string) => [`ashlr-phantom-${v}.tgz`, `ashlr-phantom-${v}.tgz.sig`, `Phantom_${v}_aarch64.app.tar.gz`,
  `Phantom_${v}_aarch64.app.tar.gz.sig`, 'manifest.json', 'manifest.json.sig', 'latest.json'];
const release = (assets: string[]) => JSON.stringify({
  tag_name: TAG, published_at: '2026-11-09T10:00:00Z', html_url: `https://github.com/ashlrai/phantom/releases/tag/${TAG}`, draft: false, prerelease: false,
  assets: assets.map(name => ({ name, state: 'uploaded', size: 10, browser_download_url: `https://github.com/ashlrai/phantom/releases/download/${TAG}/${name}` })),
});
const runner = (assets: string[], calls: string[][] = []): ReleaseRunner => async argv => { calls.push(argv); return { code: 0, stdout: release(assets) }; };

async function call(deps: Parameters<typeof createReleaseStagesApi>[0], method = 'GET', allowDispatch = true, api = createReleaseStagesApi({ now: () => NOW, ...deps })) {
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('GET /api/verse/release/stages', () => {
  it('reports a release with no assets and no feed as unknown, naming latest.json', async () => {
    const { status, body } = await call({ run: runner([]), feed: async () => null });
    expect(status).toBe(200);
    expect(body).toMatchObject({ schema: 'verse.release-stages.v1', repo: 'ashlrai/phantom', tag: TAG, checkedAt: NOW.toISOString() });
    expect(body.stages.map((s: { stage: string }) => s.stage)).toEqual(['published', 'feed-ready']);
    expect(body.stages[0]).toMatchObject({ stage: 'published', status: 'unknown' });
    expect(body.stages[0].reason).toContain('latest.json');
    expect(body.stages[1]).toMatchObject({ stage: 'feed-ready', status: 'unknown' });
  });

  it('observes both stages with seven assets and a feed serving the tag', async () => {
    const feed = async () => ({ repo: 'ashlrai/phantom', version: '3.30.8', observedAt: NOW.toISOString() });
    const { body } = await call({ run: runner(names('3.30.8')), feed });
    expect(body.stages).toMatchObject([{ stage: 'published', status: 'observed', reason: null }, { stage: 'feed-ready', status: 'observed', version: '3.30.8' }]);
  });

  it('answers 200 with no tag when the runner fails', async () => {
    const { status, body } = await call({ run: async () => ({ code: 1, stdout: '' }), feed: async () => null });
    expect(status).toBe(200);
    expect(body).toMatchObject({ tag: null, stages: [], reason: 'release unavailable; retry' });
  });

  it('rejects other methods and non-dispatch sessions', async () => {
    expect((await call({ run: runner([]) }, 'POST')).status).toBe(405);
    expect((await call({ run: runner([]) }, 'GET', false)).status).toBe(404);
  });

  it('reuses the last result inside the ttl and refreshes after it', async () => {
    const calls: string[][] = [];
    let t = NOW.getTime();
    const api = createReleaseStagesApi({ run: runner([], calls), feed: async () => null, now: () => new Date(t), ttlMs: 1000 });
    await call({}, 'GET', true, api);
    const first = calls.length;
    await call({}, 'GET', true, api);
    expect(calls.length).toBe(first);
    t += 1500;
    await call({}, 'GET', true, api);
    expect(calls.length).toBe(first * 2);
  });
});
