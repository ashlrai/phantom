import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetReleaseLive } from '../src/cli/fleet-release-live.js';
import { parseOutbox } from '../src/core/fleet/mason-outbox.js';
import { classifyOutboxText } from '../src/core/fleet/outbox-kind.js';
import { fetchLatestRelease, planReleaseNotices, type ReleaseRunner } from '../src/core/fleet/release-live-notice.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'release-live-')); dirs.push(dir); return dir; };
const payload = (tag: string, draft = false): string => JSON.stringify({ tag_name: tag, published_at: '2026-11-04T12:00:00Z', html_url: `https://github.com/example/repo/releases/tag/${tag}`, draft, prerelease: false });

describe('release live notices', () => {
  it('baselines, announces a new tag once, and produces a done outbox entry', async () => {
    const root = temp(); let tag = 'v9.9.0'; const output: string[] = [];
    const run: ReleaseRunner = async argv => ({ code: 0, stdout: payload(argv[1]!.includes('second') ? 'v1.0.0' : tag) });
    const args = ['--repo', 'example/first', '--repo', 'example/second'];
    const deps = { runsDir: root, run, output: (text: string) => output.push(text) };
    expect(await cmdFleetReleaseLive(args, deps)).toBe(0);
    expect(output.join('\n')).toContain('Baselined');
    const path = join(root, 'leader', 'MASON-OUTBOX.md');
    expect(existsSync(path)).toBe(false);
    tag = 'v9.9.1';
    expect(await cmdFleetReleaseLive(args, deps)).toBe(0);
    const entries = parseOutbox(readFileSync(path, 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toContain('Release live: example/first v9.9.1');
    expect(classifyOutboxText(entries[0]!.text)).toBe('done');
    expect(await cmdFleetReleaseLive(args, deps)).toBe(0);
    expect(parseOutbox(readFileSync(path, 'utf8'))).toHaveLength(1);
  });
  it('skips drafts and handles unreadable responses and invalid repos', async () => {
    const draft = await fetchLatestRelease('example/repo', async () => ({ code: 0, stdout: payload('v1', true) }));
    expect(planReleaseNotices([draft, null], new Set())).toEqual([]);
    expect(await fetchLatestRelease('example/repo', async () => ({ code: 0, stdout: '{' }))).toBeNull();
    expect(await fetchLatestRelease('example/repo', async () => ({ code: 1, stdout: payload('v1') }))).toBeNull();
    let calls = 0;
    expect(await cmdFleetReleaseLive(['--repo', 'bad/too/many'], { run: async () => { calls++; return { code: 1, stdout: '' }; }, error: () => {} })).toBe(2);
    expect(calls).toBe(0);
  });
});
