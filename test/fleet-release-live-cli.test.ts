import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cmdFleetReleaseLive } from '../src/cli/fleet-release-live.js';

it('reports the dry-run plan as JSON without writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cli-')); const output: string[] = [];
  try {
    const code = await cmdFleetReleaseLive(['--dry-run', '--json', '--repo', 'example/repo', '--runs-dir', root], {
      output: text => output.push(text), run: async () => ({ code: 0, stdout: JSON.stringify({ tag_name: 'v9.9.1', published_at: '2026-11-04T12:00:00Z', html_url: 'https://github.com/example/repo/releases/tag/v9.9.1', draft: false, prerelease: false }) }),
    });
    expect(code).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ announced: 0, alreadySent: 0, unreadable: 0, baselined: true, dryRun: true, notices: [{ tag: 'v9.9.1' }] });
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
