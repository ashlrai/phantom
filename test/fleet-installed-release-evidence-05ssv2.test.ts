import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetReleaseLive } from '../src/cli/fleet-release-live.js';
import { createInstalledReleaseReader } from '../src/core/fleet/installed-release-evidence.js';

const repo = 'ashlrai/phantom', tag = 'v3.30.9';
const time = '2026-11-05T12:00:00.000Z';
const metadata = (version = '3.30.9', id = 'ai.ashlr.desktop') => JSON.stringify({ CFBundleIdentifier: id, CFBundleShortVersionString: version });
const reader = (run: () => Promise<string>, platform: NodeJS.Platform = 'darwin') =>
  createInstalledReleaseReader({ platform, run, now: () => new Date(time) });

describe('installed release metadata', () => {
  it('reads valid metadata at completion', async () => {
    expect(await reader(async () => metadata())(repo, tag)).toEqual({ repo, version: '3.30.9', observedAt: time });
  });
  it.each([
    ['wrong identity', async () => metadata('3.30.9', 'other')],
    ['malformed JSON', async () => '{'],
    ['invalid version', async () => metadata('01.2.3')],
    ['missing bundle', async () => { throw new Error('ENOENT'); }],
    ['timeout or nonzero', async () => { throw new Error('command failed'); }],
    ['excessive output', async () => ' '.repeat(128 * 1024 + 1)],
  ])('returns null for %s', async (_name, run) => {
    expect(await reader(run)(repo, tag)).toBeNull();
  });
  it('does not run on unsupported platforms or other repositories', async () => {
    let calls = 0;
    const run = async () => { calls++; return metadata(); };
    expect(await reader(run, 'linux')(repo, tag)).toBeNull();
    expect(await reader(run)('other/repo', tag)).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('release-live exact tag', () => {
  it('announces matching installed metadata once and leaves older metadata unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-live-installed-'));
    const release = { tag_name: tag, published_at: '2026-11-05T11:00:00Z', html_url: `https://github.com/${repo}/releases/tag/${tag}`, draft: false, prerelease: false };
    const outputs: string[] = [];
    const deps = { runsDir: root, now: () => new Date(time), run: async () => ({ code: 0, stdout: JSON.stringify(release) }),
      feed: async () => null, installed: reader(async () => metadata()), output: (value: string) => outputs.push(value) };
    const args = ['--repo', repo, '--tag', tag, '--json'];
    expect(await cmdFleetReleaseLive(args, deps)).toBe(0);
    expect(await cmdFleetReleaseLive(args, deps)).toBe(0);
    expect(JSON.parse(outputs[0]!).observations.find((row: { stage: string }) => row.stage === 'installed').status).toBe('observed');
    expect(JSON.parse(outputs[1]!).notices).toHaveLength(0);
    const ledger = readFileSync(join(root, 'leader', 'release-milestones-sent.jsonl'), 'utf8');
    expect(ledger.match(/:installed/g)).toHaveLength(1);
    const older: string[] = [];
    expect(await cmdFleetReleaseLive([...args, '--dry-run'], { ...deps, installed: reader(async () => metadata('3.30.8')), output: value => older.push(value) })).toBe(0);
    expect(JSON.parse(older[0]!).observations.find((row: { stage: string }) => row.stage === 'installed').status).toBe('unknown');
  });
});
