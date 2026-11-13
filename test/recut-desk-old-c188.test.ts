/**
 * recut-desk-old-c188 — recut-of-#3530 guard for the recovered
 * fleet_path_cochanges surface: the data hook must hand back the same
 * sanitized envelope the MCP tool serves, so no secret-shaped cochange
 * path, evidence sha or job id can ride out of the isolated fleet server.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseFleetPathCochangesArgs, readFleetPathCochanges } from '../src/mcp/fleet-path-cochanges.js';

const sha = (c: string) => c.repeat(40);

describe('readFleetPathCochanges data hook (recut of #3530)', () => {
  it('sanitizes fine-grained tokens embedded in cochange paths and evidence', async () => {
    const pat = `github_pat_${'A'.repeat(22)}_${'B9c'.repeat(20)}`;
    const read = vi.fn(async (path: string) => ({
      path,
      resolvedRef: sha('f'),
      sampledCount: 10,
      examinedCount: 4,
      commitsTruncated: false,
      matchesTruncated: false,
      pathsTruncated: false,
      omittedPaths: 0,
      paths: [
        { path: `secrets/${pat}.txt`, count: 3, evidence: [{ sha: sha('e'), jobId: `RQ-${pat}` }] },
        { path: 'src/plain.ts', count: 1, evidence: [{ sha: sha('a'), jobId: 'RQ-OK-1' }] },
      ],
      notice: 'Cochange evidence does not prove a dependency or authorize edits.',
    }));
    const out = await readFleetPathCochanges({ path: 'src/plain.ts', limit: 5 }, { read });
    expect(read).toHaveBeenCalledWith('src/plain.ts', { limit: 5 });
    expect(out).toMatchObject({
      snapshotKind: 'local-persisted',
      authority: 'none',
      path: 'src/plain.ts',
      resolvedRef: sha('f'),
    });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(pat);
    expect(wire).toContain('REDACTED');
    expect(wire).toContain('RQ-OK-1');
    expect(out.paths[1]).toMatchObject({ path: 'src/plain.ts', count: 1 });
  });

  it('rejects a token-shaped edit path at the shared validator before any read', async () => {
    const read = vi.fn();
    for (const args of [
      { path: `../${'ghp_' + 'Z'.repeat(24)}` },
      { path: 'a\\..\\b' },
      { path: 'ok.ts', limit: 0 },
      { path: 'ok.ts', ref: 'main' },
    ]) {
      expect(parseFleetPathCochangesArgs(args)).toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
    expect(parseFleetPathCochangesArgs({ path: 'src/plain.ts' })).toEqual({ path: 'src/plain.ts', limit: 20 });
  });
});
