import { expect, it, vi } from 'vitest';
import { cmdRelease } from '../src/cli/release.js';

it('reports the installed and published versions through the release command', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const code = await cmdRelease(['lag', '--json'], {
      run: async ([, endpoint]) => ({ code: 0, stdout: JSON.stringify(endpoint?.startsWith('repos/')
        ? { tag_name: 'v9.9.9-test', published_at: '2026-01-01T00:00:00Z', assets: [] }
        : { total_count: 2 }) }),
      feedStatus: async () => 200,
      installedVersion: async () => '9.9.8-test',
    });
    expect(code).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      latestTag: 'v9.9.9-test', installedVersion: '9.9.8-test', feedOk: true, mergedSince: 2,
    });
  } finally { output.mockRestore(); }
});
