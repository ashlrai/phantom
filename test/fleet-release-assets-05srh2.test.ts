import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetReleaseLive } from '../src/cli/fleet-release-live.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tag = 'v1.2.3';
const names = ['ashlr-phantom-1.2.3.tgz', 'ashlr-phantom-1.2.3.tgz.sig', 'Phantom_1.2.3_aarch64.app.tar.gz',
  'Phantom_1.2.3_aarch64.app.tar.gz.sig', 'manifest.json', 'manifest.json.sig', 'latest.json'];
const assets = () => names.map(name => ({ name, state: 'uploaded', size: 1,
  browser_download_url: `https://github.com/ashlrai/phantom/releases/download/${tag}/${name}` }));
const now = new Date('2026-11-05T08:00:00Z');

describe('desktop release asset evidence', () => {
  it('retries the same tag until all assets are present, without claiming feed or installation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-assets-')); roots.push(root);
    let current: unknown = [];
    let output = '';
    const run = async () => ({ code: 0, stdout: JSON.stringify({ tag_name: tag, published_at: '2026-11-05T07:00:00Z',
      html_url: 'https://github.com/ashlrai/phantom/releases/tag/v1.2.3', draft: false, prerelease: false, assets: current }) });
    const invoke = async () => {
      expect(await cmdFleetReleaseLive(['--repo', 'ashlrai/phantom', '--tag', tag, '--json'],
        { runsDir: root, run, feed: async () => null, now: () => now, output: text => { output = text; } })).toBe(0);
      return JSON.parse(output) as { announced: number; observations: { status: string; reason: string | null; version: string | null; observedAt: string | null }[] };
    };
    let result = await invoke();
    expect(result.announced).toBe(0);
    expect(result.observations[0]).toMatchObject({ status: 'unknown', version: tag, observedAt: '2026-11-05T07:00:00Z' });
    expect(result.observations[0]!.reason).toContain('latest.json');
    current = assets().slice(0, -1);
    result = await invoke();
    expect(result.observations[0]!.reason).toContain('latest.json');
    current = assets().map(a => a.name === 'manifest.json.sig' ? { ...a, size: 0 } : a);
    result = await invoke();
    expect(result.observations[0]!.reason).toContain('manifest.json.sig');
    current = assets();
    result = await invoke();
    expect(result.announced).toBe(1);
    expect(result.observations.map(o => o.status)).toEqual(['observed', 'unknown', 'unknown']);
    expect((await invoke()).announced).toBe(0);
    expect(readFileSync(join(root, 'leader', 'release-milestones-sent.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(join(root, 'leader', 'MASON-OUTBOX.md'), 'utf8')).toContain('is published');
  });

  it('preserves other repository publication behavior without assets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-assets-')); roots.push(root);
    let output = '';
    const code = await cmdFleetReleaseLive(['--repo', 'example/repo', '--tag', tag, '--json'], {
      runsDir: root, now: () => now, feed: async () => null, output: text => { output = text; },
      run: async () => ({ code: 0, stdout: JSON.stringify({ tag_name: tag, published_at: '2026-11-05T07:00:00Z',
        html_url: 'https://github.com/example/repo/releases/tag/v1.2.3', draft: false, prerelease: false }) }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(output).announced).toBe(1);
  });
});
