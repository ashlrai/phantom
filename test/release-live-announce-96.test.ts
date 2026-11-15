import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  planReleaseAnnouncement, readLiveRelease, runReleaseAnnouncement, type ObservedRelease,
} from '../src/core/fleet/release-live-announce.js';
import type { ReleaseRunner } from '../src/core/fleet/release-live-notice.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rla96-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const statePath = () => join(dir, 'release-announce.json');
function harness(release: ObservedRelease | null, installed: string | null) {
  const posts: string[] = [];
  const state = { release, installed };
  const run = () => runReleaseAnnouncement({
    stateDir: dir, readRelease: async () => state.release, readInstalled: () => state.installed, post: t => { posts.push(t); },
  });
  return { posts, state, run };
}

describe('release live announcement', () => {
  it('posts a new live version once and records it', async () => {
    const h = harness({ version: '3.30.33', live: true }, '3.30.32');
    await h.run();
    expect(h.posts).toEqual(['Phantom v3.30.33 is published and the update feed is live. Installed here: v3.30.32.']);
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({ announced: '3.30.33', installedAnnounced: null });
  });

  it('posts nothing when the release is not live or unreadable', async () => {
    const h = harness({ version: '3.30.33', live: false }, '3.30.32');
    await h.run();
    h.state.release = null;
    await h.run();
    expect(h.posts).toEqual([]);
  });

  it('posts nothing on a repeat run', async () => {
    const h = harness({ version: '3.30.33', live: true }, '3.30.32');
    await h.run(); await h.run();
    expect(h.posts).toHaveLength(1);
  });

  it('posts the installed follow-up once after catch-up', async () => {
    const h = harness({ version: '3.30.33', live: true }, '3.30.32');
    await h.run();
    h.state.installed = '3.30.33';
    await h.run(); await h.run();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]).toBe('Installed v3.30.33 on this Mac');
  });

  it('a concurrent double run posts once', async () => {
    const h = harness({ version: '3.30.33', live: true }, '3.30.32');
    await Promise.all([h.run(), h.run()]);
    expect(h.posts).toHaveLength(1);
  });

  it('treats a corrupt state file as empty without throwing', async () => {
    writeFileSync(statePath(), '{not json', { mode: 0o600 });
    const h = harness({ version: '3.30.33', live: true }, '3.30.32');
    await expect(h.run()).resolves.toMatchObject({ posted: expect.any(Array) });
    expect(h.posts).toHaveLength(1);
  });

  it('does not re-announce on first run when the app already has the release', () => {
    const plan = planReleaseAnnouncement({ announced: null, installedAnnounced: null }, { version: '3.30.33', live: true }, '3.30.33');
    expect(plan.messages).toEqual([]);
    expect(plan.state).toEqual({ announced: '3.30.33', installedAnnounced: '3.30.33' });
  });

  it('retries after a failed post', async () => {
    const h = harness({ version: '3.30.33', live: true }, null);
    await expect(runReleaseAnnouncement({ stateDir: dir, readRelease: async () => h.state.release, readInstalled: () => null,
      post: () => { throw new Error('thread down'); } })).rejects.toThrow('thread down');
    await h.run();
    expect(h.posts).toEqual(['Phantom v3.30.33 is published and the update feed is live. Installed here: unknown.']);
  });
});

describe('readLiveRelease', () => {
  const tag = 'v3.30.33';
  const v = '3.30.33';
  const names = [`ashlr-phantom-${v}.tgz`, `ashlr-phantom-${v}.tgz.sig`, `Phantom_${v}_aarch64.app.tar.gz`,
    `Phantom_${v}_aarch64.app.tar.gz.sig`, 'manifest.json', 'manifest.json.sig', 'latest.json'];
  const body = (assets: string[], draft = false) => JSON.stringify({
    tag_name: tag, published_at: '2025-01-01T00:00:00Z', html_url: `https://github.com/ashlrai/phantom/releases/tag/${tag}`,
    draft, prerelease: false,
    assets: assets.map(name => ({ name, state: 'uploaded', size: 10,
      browser_download_url: `https://github.com/ashlrai/phantom/releases/download/${tag}/${name}` })),
  });
  const runner = (assets: string[]): ReleaseRunner => async () => ({ code: 0, stdout: body(assets) });
  const feedOk = async () => ({ repo: 'ashlrai/phantom', version: v, observedAt: new Date().toISOString() });

  it('is live with full assets and a serving feed', async () => {
    expect(await readLiveRelease(runner(names), feedOk)).toEqual({ version: v, live: true });
  });
  it('is not live with 0 assets', async () => {
    expect(await readLiveRelease(runner([]), feedOk)).toEqual({ version: v, live: false });
  });
  it('is not live when the feed is a 404', async () => {
    expect(await readLiveRelease(runner(names), async () => null)).toEqual({ version: v, live: false });
  });
  it('ignores drafts', async () => {
    const run: ReleaseRunner = async () => ({ code: 0, stdout: body(names, true) });
    expect(await readLiveRelease(run, feedOk)).toBeNull();
  });
});
