import { beforeEach, describe, expect, it, vi } from 'vitest';

const gh = vi.hoisted(() => ({ runGhAsync: vi.fn() }));
vi.mock('../src/core/integrations/github.js', () => ({ runGhAsync: gh.runGhAsync }));

import { ghPrSource } from '../src/core/release/pr-notes.js';

/**
 * The real `gh` reader behind `phm release notes --repo`. Hermetic: runGhAsync
 * is the only seam, so no test touches GitHub or spawns a process.
 */
describe('ghPrSource.mergedSince', () => {
  beforeEach(() => gh.runGhAsync.mockReset());

  it('rejects an invalid tag without calling gh', async () => {
    await expect(ghPrSource.mergedSince('ashlrai/phantom', 'bad tag!')).rejects.toThrow('Invalid release tag');
    expect(gh.runGhAsync).not.toHaveBeenCalled();
  });

  it('reads the tag stamp, then lists merged PRs after it', async () => {
    gh.runGhAsync
      .mockResolvedValueOnce('2026-11-22T17:14:53Z')
      .mockResolvedValueOnce(JSON.stringify([
        { number: 1, title: 'feat: add search', body: '', mergedAt: '2026-11-23T00:00:00Z', files: [] },
        { number: 2, title: 'fix: old', body: '', mergedAt: '2026-11-01T00:00:00Z', files: [] },
      ]));
    const out = await ghPrSource.mergedSince('ashlrai/phantom', 'v3.30.71');
    expect(out.prs.map(pr => pr.number)).toEqual([1]);
    expect(out.complete).toBe(true);
    // The tag-stamp read is the command's first gh call: it gets the same
    // extended budget as the list read so a cold CLI cannot time out into a
    // false "cannot read the tag".
    expect(gh.runGhAsync).toHaveBeenNthCalledWith(1, expect.any(String),
      ['api', 'repos/ashlrai/phantom/commits/v3.30.71', '--jq', '.commit.committer.date'], undefined, 60_000);
    // The files-bearing list read opts into a longer timeout than the 8 s default.
    expect(gh.runGhAsync).toHaveBeenNthCalledWith(2, expect.any(String),
      expect.arrayContaining(['pr', 'list', '--repo', 'ashlrai/phantom', '--state', 'merged']), undefined, 60_000);
  });

  it('reports a gh transport failure instead of blaming the tag', async () => {
    // Every call answers null: gh is missing, signed out or offline. The repo
    // probe fails too, so the error names the transport, not the tag.
    gh.runGhAsync.mockResolvedValue(null);
    await expect(ghPrSource.mergedSince('ashlrai/phantom', 'v3.30.71'))
      .rejects.toThrow('Cannot reach the repo through gh');
    expect(gh.runGhAsync).toHaveBeenCalledTimes(2);
    // The repo probe shares the extended budget: a slow probe must not read as
    // a dead transport either.
    expect(gh.runGhAsync).toHaveBeenNthCalledWith(2, expect.any(String),
      ['api', 'repos/ashlrai/phantom', '--jq', '.full_name'], undefined, 60_000);
  });

  it('keeps the tag message when the repo reads but the ref does not', async () => {
    gh.runGhAsync
      .mockResolvedValueOnce(null)                    // commits/<tag> unreadable
      .mockResolvedValueOnce('ashlrai/phantom');      // repo itself readable
    await expect(ghPrSource.mergedSince('ashlrai/phantom', 'v9.9.9'))
      .rejects.toThrow('Cannot read the release tag from GitHub');
    expect(gh.runGhAsync).toHaveBeenCalledTimes(2);
  });
});
