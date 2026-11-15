import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  readFleetJobCurrentSnapshot, type FleetJobCurrentSnapshotArgs,
} from '../../src/mcp/fleet-job-current-snapshot.js';
import { jobCurrentSnapshot, type JobCurrentSnapshotReport } from '../../src/core/fleet/job-current-snapshot.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
});

async function connect(reader?: FleetReaders['jobCurrentSnapshot'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'job-current-snapshot-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({ pending: 2 }), loop: async () => ({}), ...readers, jobCurrentSnapshot: reader }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
const text = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;

const OID = (c: string) => c.repeat(40);
const SHA1 = OID('a'), PINNED = OID('d');
const SNAP64 = 'f'.repeat(64);

const baseReport = (over: Partial<JobCurrentSnapshotReport> = {}): JobCurrentSnapshotReport => ({
  jobId: 'RQ-CUR-7', resolvedRef: PINNED,
  scanBound: 1000, scanned: 1, scanMayBeTruncated: false, matchesTruncated: false,
  commit: { sha: SHA1, date: '2026-10-31T00:33:00Z', pr: 42 },
  pathBound: 200, omittedPaths: 0,
  summary: { unchanged: 1, changed: 0, absentNow: 0, absentAtBoth: 0 },
  entries: [
    { path: 'src/kept.ts', status: 'unchanged',
      atCommit: { mode: '100644', type: 'blob', oid: OID('1') },
      atCurrent: { mode: '100644', type: 'blob', oid: OID('1') } },
  ],
  requestedSnapshot: PINNED,
  caveat: 'Replayed from requestedSnapshot, which was verified as a commit and an ancestor of origin/master at request time.',
  ...over,
});

/** Temporary repo with real git; every helper touches only this directory. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-job-current-snapshot-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const write = (path: string, content: string) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const commit = (subject: string, files: Record<string, string>, remove: string[] = []) => {
    for (const [path, content] of Object.entries(files)) write(path, content);
    for (const path of remove) git('rm', '-q', path);
    git('add', '.'); git('commit', '-qm', subject);
    return git('rev-parse', 'HEAD').trim();
  };
  const publish = (oid: string) => git('update-ref', 'refs/remotes/origin/master', oid);
  git('init', '-q'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
  return { dir, git, commit, publish, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The real snapshot reader with the temp repo's git behind the injected run seam. */
const viaRealReader = (dir: string) => {
  const calls: string[][] = [];
  const reader = (input: FleetJobCurrentSnapshotArgs) =>
    readFleetJobCurrentSnapshot(input, {
      read: (snapshot, job) => jobCurrentSnapshot(snapshot, job, async args => {
        calls.push(args);
        return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      }),
    });
  return { calls, reader };
};

describe('fleet_job_current_snapshot over MCP', () => {
  it('is advertised read-only with required jobId and snapshot and no caller ref', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_job_current_snapshot');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        jobId: { type: 'string', description: expect.stringContaining('Exact') },
        snapshot: { type: 'string', pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$', description: expect.stringContaining('ancestor') },
      },
      required: ['jobId', 'snapshot'],
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/origin\/master/);
    expect(tool?.description).toMatch(/Replay/);
    expect(tool?.description).toMatch(/not a live reading/i);
    expect(tool?.description).toMatch(/does not prove the job never landed/i);
    expect(tool?.description).toMatch(/never missing work/i);
    expect(tool?.description).toMatch(/correctness, live lane, dispatch or merge-queue verdict/i);
    expect(tool?.description).toMatch(/no caller ref, filesystem root or cwd/i);
  });

  it('delegates once to the reader and returns the envelope with requestedSnapshot and truncation evidence', async () => {
    const read = vi.fn(async () => baseReport({
      scanned: 1000, scanMayBeTruncated: true, matchesTruncated: true, omittedPaths: 5,
    }));
    const client = await connect(input => readFleetJobCurrentSnapshot(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_current_snapshot', arguments: { jobId: 'RQ-CUR-7', snapshot: PINNED } }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(PINNED, 'RQ-CUR-7');
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      jobId: 'RQ-CUR-7', requestedSnapshot: PINNED, resolvedRef: PINNED,
      scanBound: 1000, scanned: 1000, scanMayBeTruncated: true, matchesTruncated: true,
      commit: { sha: SHA1, date: '2026-10-31T00:33:00Z', pr: 42 },
      pathBound: 200, omittedPaths: 5,
      summary: { unchanged: 1, changed: 0, absentNow: 0, absentAtBoth: 0 },
    });
    expect(out).not.toHaveProperty('ref');
    expect(typeof out.generatedAt).toBe('string');
    expect(out.caveat).toMatch(/not current live origin\/master|verified as a commit/i);
    expect(out.note).toMatch(/not current live origin\/master/i);
    expect(out.note).toMatch(/does not prove the job never landed/i);
    expect(out.note).toMatch(/never missing work/i);
    expect(out.entries).toEqual(baseReport().entries);
  });

  it('replays captured tree evidence through the real reader after origin/master advances', async () => {
    const repo = fixture();
    try {
      repo.commit('bridge(RQ-PRE-0): seed (#10)', { 'gone.ts': 'x' });
      const bridge = repo.commit('bridge(RQ-AAA-1): first job (#11)', { 'a.ts': 'a', 'del.ts': 'd' });
      repo.commit('bridge(RQ-DEL-4): cleanup job (#14)', {}, ['gone.ts']);
      const recorded = repo.commit('bridge(RQ-BBB-2): second job (#12)', { 'a.ts': 'b' });
      repo.publish(recorded);
      const { calls, reader } = viaRealReader(repo.dir);
      const client = await connect(reader);
      const args = { jobId: 'RQ-AAA-1', snapshot: recorded };

      const first = parse(await client.callTool({ name: 'fleet_job_current_snapshot', arguments: args }));
      expect(first).toMatchObject({
        jobId: 'RQ-AAA-1', requestedSnapshot: recorded, resolvedRef: recorded,
        commit: { sha: bridge, pr: 11 },
        summary: { unchanged: 1, changed: 1, absentNow: 0, absentAtBoth: 0 },
      });
      expect(first).not.toHaveProperty('ref');
      const blobAt = (oid: string, path: string) => repo.git('rev-parse', `${oid}:${path}`).trim();
      expect(first.entries).toEqual([
        { path: 'a.ts', status: 'changed',
          atCommit: { mode: '100644', type: 'blob', oid: blobAt(bridge, 'a.ts') },
          atCurrent: { mode: '100644', type: 'blob', oid: blobAt(recorded, 'a.ts') } },
        { path: 'del.ts', status: 'unchanged',
          atCommit: { mode: '100644', type: 'blob', oid: blobAt(bridge, 'del.ts') },
          atCurrent: { mode: '100644', type: 'blob', oid: blobAt(recorded, 'del.ts') } },
      ]);

      // origin/master moves on: a.ts edited again and del.ts deleted.
      const later = repo.commit('bridge(RQ-CCC-3): third job (#13)', { 'a.ts': 'c', 'z.ts': 'z' }, ['del.ts']);
      repo.publish(later);
      const replay = parse(await client.callTool({ name: 'fleet_job_current_snapshot', arguments: args }));
      expect(replay).toMatchObject({ requestedSnapshot: recorded, resolvedRef: recorded, commit: { sha: bridge } });
      const { generatedAt: _first, ...restFirst } = first;
      const { generatedAt: _replay, ...restReplay } = replay;
      expect(restReplay).toEqual(restFirst);
      // The pinned tree, not live master: del.ts is unchanged at the snapshot
      // (absent-now live) and a.ts compares against the recorded blob, not the newer one.
      expect(replay.entries.find((e: { path: string }) => e.path === 'del.ts').status).toBe('unchanged');
      expect(replay.entries.find((e: { path: string }) => e.path === 'a.ts').atCurrent.oid)
        .toBe(blobAt(recorded, 'a.ts'));
      expect(replay.entries.find((e: { path: string }) => e.path === 'a.ts').atCurrent.oid)
        .not.toBe(blobAt(later, 'a.ts'));
      // The ref substitution is a pin, not a git resolution: rev-parse never ran.
      expect(calls.filter(argv => argv[0] === 'rev-parse')).toEqual([]);
      expect(calls.slice(0, 2)).toEqual([
        ['cat-file', '-t', recorded], ['merge-base', '--is-ancestor', recorded, 'origin/master'],
      ]);
    } finally { repo.cleanup(); }
  });

  it('reports a landed deletion as absent-at-both through the real reader', async () => {
    const repo = fixture();
    try {
      repo.commit('bridge(RQ-PRE-0): seed (#10)', { 'gone.ts': 'x' });
      repo.commit('bridge(RQ-DEL-4): cleanup job (#14)', {}, ['gone.ts']);
      const tip = repo.commit('bridge(RQ-BBB-2): second job (#12)', { 'a.ts': 'a' });
      repo.publish(tip);
      const { reader } = viaRealReader(repo.dir);
      const client = await connect(reader);
      const out = parse(await client.callTool({ name: 'fleet_job_current_snapshot', arguments: { jobId: 'RQ-DEL-4', snapshot: tip } }));
      expect(out.entries).toEqual([
        { path: 'gone.ts', status: 'absent-at-both', atCommit: null, atCurrent: null },
      ]);
      expect(out.summary).toMatchObject({ absentAtBoth: 1 });
      expect(out.note).toMatch(/never missing work/i);
    } finally { repo.cleanup(); }
  });

  it('turns non-ancestor, missing and non-commit OIDs into tool errors, never empty success', async () => {
    const repo = fixture();
    try {
      const base = repo.commit('bridge(RQ-AAA-1): first job (#11)', { 'a.ts': 'a' });
      const tip = repo.commit('bridge(RQ-BBB-2): second job (#12)', { 'a.ts': 'b' });
      repo.publish(tip);
      const side = repo.git('commit-tree', `${tip}^{tree}`, '-p', base, '-m', 'bridge(RQ-SIDE-9): side').trim();
      const tree = repo.git('rev-parse', `${tip}^{tree}`).trim();
      const { reader } = viaRealReader(repo.dir);
      const client = await connect(reader);
      const filesBefore = readdirSync(repo.dir, { recursive: true }).sort();
      for (const snapshot of [side, OID('9'), SNAP64, tree]) {
        const result = await client.callTool({ name: 'fleet_job_current_snapshot', arguments: { jobId: 'RQ-AAA-1', snapshot } });
        expect(result.isError).toBe(true);
        expect(text(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
      }
      // The same commit replays once it is reachable from origin/master.
      const ok = await client.callTool({ name: 'fleet_job_current_snapshot', arguments: { jobId: 'RQ-AAA-1', snapshot: base } });
      expect(ok.isError).not.toBe(true);
      expect(parse(ok)).toMatchObject({ requestedSnapshot: base, resolvedRef: base, commit: { sha: base }, authority: 'none' });
      expect(readdirSync(repo.dir, { recursive: true }).sort()).toEqual(filesBefore);
    } finally { repo.cleanup(); }
  });

  it.each([
    {},
    { jobId: 'RQ-CUR-7' },
    { snapshot: PINNED },
    { jobId: 5, snapshot: PINNED }, { jobId: null, snapshot: PINNED },
    { jobId: 'rq-cur-7', snapshot: PINNED }, { jobId: 'RQ-A B', snapshot: PINNED },
    { jobId: 'JOB-1', snapshot: PINNED }, { jobId: 'RQ-A/B', snapshot: PINNED },
    { jobId: 'RQ-CUR-7', snapshot: 5 }, { jobId: 'RQ-CUR-7', snapshot: null },
    { jobId: 'RQ-CUR-7', snapshot: 'HEAD' }, { jobId: 'RQ-CUR-7', snapshot: 'origin/master' },
    { jobId: 'RQ-CUR-7', snapshot: 'master' }, { jobId: 'RQ-CUR-7', snapshot: 'HEAD~1' },
    { jobId: 'RQ-CUR-7', snapshot: `${PINNED}..${PINNED}` },
    { jobId: 'RQ-CUR-7', snapshot: PINNED.slice(0, 12) },
    { jobId: 'RQ-CUR-7', snapshot: PINNED.slice(0, 39) },
    { jobId: 'RQ-CUR-7', snapshot: `${PINNED}0` },
    { jobId: 'RQ-CUR-7', snapshot: PINNED.toUpperCase() },
    { jobId: 'RQ-CUR-7', snapshot: 'f'.repeat(64).toUpperCase() },
    { jobId: 'RQ-CUR-7', snapshot: 'refs/heads/main' },
    { jobId: 'RQ-CUR-7', snapshot: `g${'0'.repeat(39)}` },
    { jobId: 'RQ-CUR-7', snapshot: PINNED, ref: 'HEAD' },
    { jobId: 'RQ-CUR-7', snapshot: PINNED, cwd: '/tmp' },
    { jobId: 'RQ-CUR-7', snapshot: PINNED, root: '/' },
    { jobId: 'RQ-CUR-7', snapshot: PINNED, path: 'src' },
    { jobId: 'RQ-CUR-7', snapshot: PINNED, limit: 5 },
    { jobId: 'RQ-CUR-7', snapshot: PINNED, extra: 1 },
  ])('rejects invalid arguments before any read: %j', async args => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_job_current_snapshot', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports a reader failure as a tool error with no internal detail', async () => {
    const client = await connect(async () => { throw new Error('fatal: not a git repo; token ghp_secretvalue'); });
    const result = await client.callTool({ name: 'fleet_job_current_snapshot', arguments: { jobId: 'RQ-CUR-7', snapshot: PINNED } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/ghp_|not a git repo/);
  });

  it('keeps unknown-tool rejection and leaves existing tools working', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'fleet_job_current_snapshot_delete' })).rejects.toMatchObject({ code: -32602 });
    expect(parse(await client.callTool({ name: 'fleet_status' }))).toEqual({ pending: 2 });
  });
});
