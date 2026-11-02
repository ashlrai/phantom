import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianDrain } from '../src/cli/fleet-guardian-drain.js';
import { createGuardianDrainSession, GUARDIAN_DRAIN_SESSION_PREFIX } from '../src/core/fleet/guardian-drain-session.js';
import type { GuardianDrainSummary } from '../src/core/fleet/guardian-retry-drain.js';
import type { GuardianVerifyExclusiveDeps, GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';
import type { GuardianOptions } from '../src/core/fleet/guardian-verify-loop.js';

// All paths and shas are synthetic; the injected select/prepare/verify seams
// never touch real hosts and never spawn verification processes.
type SessionSummary = GuardianDrainSummary & { session: string | null };
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-drain-session-'));
  dirs.push(dir);
  const parent = join(dir, 'out');
  await writeFile(join(dir, 'manifest.json'), '[]'); // placeholder; the injected seam never reads it
  await writeFile(join(dir, 'state.json'), '{"version":1,"entries":[]}');
  await mkdir(parent);
  let selected = 0;
  const identity = () => ({ repo: `/fake/repo-${++selected}`, sha: String(selected).repeat(40) });
  const select = vi.fn(async () => identity());
  // 'wx' keeps the core drain's exclusive-create, never-overwrite contract.
  const prepare = vi.fn(async (o: { outputState: string }) => {
    await writeFile(o.outputState, `state-for-${o.outputState}`, { flag: 'wx' });
    return { removed: 0, retained: 0, nextAction: 'synthetic' };
  });
  const ran = { state: 'ran', summary: { deadlineExceeded: false, cancelled: false } } as unknown as GuardianVerifyExclusiveResult;
  const verify = vi.fn(async (_options: GuardianOptions, _deps?: GuardianVerifyExclusiveDeps) => ran);
  const args = ['--manifest', join(dir, 'manifest.json'), '--source-state', join(dir, 'state.json'), '--output-dir', parent,
    '--max-retries', '2', '--timeout-ms', '60000'];
  return { dir, parent, args, select, prepare, verify };
}

async function run(args: string[], deps: Parameters<typeof cmdFleetGuardianDrain>[1]) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((v?: unknown) => { lines.push(String(v)); });
  try { return { code: await cmdFleetGuardianDrain(args, deps), json: lines.map(l => JSON.parse(l) as SessionSummary) }; }
  finally { spy.mockRestore(); }
}

// Session children are the mkdtemp directories; attempt files share the
// 'guardian-drain-' prefix, so discriminate by directory-ness.
const sessionChildren = async (parent: string) => {
  const names = await readdir(parent).catch(() => [] as string[]);
  const dirsOnly = await Promise.all(names.map(async name =>
    name.startsWith(GUARDIAN_DRAIN_SESSION_PREFIX) && (await lstat(join(parent, name))).isDirectory() ? name : null));
  return dirsOnly.filter((name): name is string => name !== null);
};

describe('guardian-drain --new-session', () => {
  it('two applied runs under one parent allocate distinct private children and preserve the first run', async () => {
    const o = await setup();
    const first = await run([...o.args, '--apply', '--new-session', '--json'], o);
    expect(first.code).toBe(0);
    const firstSummary = first.json[0]!;
    expect(firstSummary).toMatchObject({ mode: 'apply', termination: 'max-retries', attempts: 2, verified: 2 });
    const sessionA = firstSummary.session!;
    expect(dirname(sessionA)).toBe(o.parent);
    expect(sessionA).toContain(GUARDIAN_DRAIN_SESSION_PREFIX);
    expect(firstSummary.latestOutput).toBe(join(sessionA, 'guardian-drain-attempt-2.json'));
    // mkdtemp default: private 0700, directly under the existing parent.
    expect(((await lstat(sessionA)).mode & 0o777).toString(8)).toBe('700');
    const bytesA = await readFile(join(sessionA, 'guardian-drain-attempt-1.json'), 'utf8');

    o.select.mockClear(); o.prepare.mockClear();
    const second = await run([...o.args, '--apply', '--new-session', '--json'], o);
    expect(second.code).toBe(0);
    const sessionB = second.json[0]!.session!;
    expect(sessionB).not.toBe(sessionA);
    expect(dirname(sessionB)).toBe(o.parent);
    expect(second.json[0]!.latestOutput).toBe(join(sessionB, 'guardian-drain-attempt-2.json'));
    // The first session's artifacts are never reused, renamed or deleted.
    expect(await readFile(join(sessionA, 'guardian-drain-attempt-1.json'), 'utf8')).toBe(bytesA);
    expect(await sessionChildren(o.parent)).toHaveLength(2);
    expect(o.select).toHaveBeenCalled();
    expect(o.prepare.mock.calls.every(([arg]) => (arg as { outputState: string }).outputState.startsWith(`${sessionB}/`))).toBe(true);
  });

  it('without --new-session the default behavior is unchanged: parent outputs, session null, collision preserved', async () => {
    const o = await setup();
    const first = await run([...o.args, '--apply', '--json'], o);
    expect(first.code).toBe(0);
    expect(first.json[0]).toMatchObject({ session: null, latestOutput: join(o.parent, 'guardian-drain-attempt-2.json') });
    expect(await sessionChildren(o.parent)).toHaveLength(0);
    o.select.mockClear();
    const second = await run([...o.args, '--apply', '--json'], o);
    expect(second.code).toBe(3); // guardian-drain-attempt-1.json already exists: overwrite refused
    expect(second.json[0]).toMatchObject({ termination: 'collision', attempts: 0, session: null });
    expect(o.verify).toHaveBeenCalledTimes(2); // only the first run verified
  });

  it('preview with --new-session stays read-only and reports a fresh session without allocating', async () => {
    const o = await setup();
    const result = await run([...o.args, '--new-session', '--json'], o);
    expect(result.code).toBe(0);
    expect(result.json[0]).toMatchObject({ mode: 'preview', termination: 'planned', attempts: 0, session: 'fresh', latestOutput: null });
    const human: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((v?: unknown) => { human.push(String(v)); });
    const code = await cmdFleetGuardianDrain([...o.args, '--new-session'], o);
    spy.mockRestore();
    expect(code).toBe(0);
    expect(human[0]).toContain('session=fresh');
    expect(await sessionChildren(o.parent)).toHaveLength(0);
    expect(o.verify).not.toHaveBeenCalled();
    // Without --new-session a preview reports no session intent at all.
    const plain = await run([...o.args, '--json'], o);
    expect(plain.json[0]!.session).toBeNull();
  });

  it('duplicated or unknown arguments allocate nothing and exit 2', async () => {
    const o = await setup();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const args of [
      [...o.args, '--apply', '--new-session', '--new-session'],
      [...o.args, '--apply', '--new-session', '--bogus'],
      [...o.args, '--apply', '--new-session', '--json', '--stream'],
    ]) {
      expect(await cmdFleetGuardianDrain(args, o), args.join(' ')).toBe(2);
    }
    err.mockRestore();
    expect(await sessionChildren(o.parent)).toHaveLength(0);
    expect(o.verify).not.toHaveBeenCalled();
  });

  it('a preexisting stop file short-circuits before any allocation', async () => {
    const o = await setup();
    const stop = join(o.dir, 'stop');
    await writeFile(stop, 'stop');
    const result = await run([...o.args, '--apply', '--new-session', '--stop-file', stop, '--json'], o);
    expect(result.json[0]).toMatchObject({ termination: 'stopped', attempts: 0, session: null });
    expect(await sessionChildren(o.parent)).toHaveLength(0);
    expect(o.select).not.toHaveBeenCalled();
    expect(o.verify).not.toHaveBeenCalled();
  });

  it('a failed allocation fails bounded and launches no verification', async () => {
    const o = await setup();
    const missing = join(o.dir, 'missing-parent');
    const args = o.args.map((v, i) => o.args[i - 1] === '--output-dir' ? missing : v);
    const result = await run([...args, '--apply', '--new-session', '--json'], o);
    expect(result.code).toBe(3);
    expect(result.json[0]).toMatchObject({ mode: 'apply', termination: 'unsafe', attempts: 0, session: null });
    expect(o.select).not.toHaveBeenCalled();
    expect(o.prepare).not.toHaveBeenCalled();
    expect(o.verify).not.toHaveBeenCalled();
  });

  it('human output prints the session path and stream records carry sanitized session/latestOutput', async () => {
    const o = await setup();
    const human: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((v?: unknown) => { human.push(String(v)); });
    const applied = await cmdFleetGuardianDrain([...o.args, '--apply', '--new-session'], o);
    spy.mockRestore();
    expect(applied).toBe(0);
    const line = human[0]!;
    expect(line).toContain('session=/'); // tmpdir lives outside HOME, so sanitization keeps the raw path
    expect(line).toContain(`latest=${join(line.split('session=')[1]!.trim(), 'guardian-drain-attempt-2.json')}`);

    o.select.mockClear();
    const lines: string[] = [];
    const code = await cmdFleetGuardianDrain([...o.args, '--apply', '--new-session', '--stream'], { ...o, writeLine: l => { lines.push(l); } });
    expect(code).toBe(0);
    const records = lines.map(l => JSON.parse(l) as Record<string, unknown>);
    expect(records.map(r => r.record)).toEqual(['attempt', 'attempt', 'summary']);
    const summary = records[2]!;
    expect(String(summary.session)).toContain(GUARDIAN_DRAIN_SESSION_PREFIX);
    expect(summary.latestOutput).toBe(join(String(summary.session), 'guardian-drain-attempt-2.json'));
    for (const record of records) expect(JSON.stringify(record)).not.toContain(process.env.HOME!);
    expect((records[0] as { latestOutput: string }).latestOutput.startsWith(String(summary.session))).toBe(true);
  });

  it('session allocator rejects a relative parent without creating anything', async () => {
    await expect(createGuardianDrainSession('relative/out')).rejects.toMatchObject({ code: 'EINVAL' });
  });
});
