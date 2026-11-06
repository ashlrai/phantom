import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/agent-wait-capacity.mjs');
const lane = (name: string, running: unknown, target: unknown, held: unknown) => ({
  lane: name, running, target, held, floor: null, ceiling: null, queued: 0,
  heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null,
});
const snapshot = {
  v: 1, generatedAt: '2026-10-31T00:00:00Z', runsDirPresent: true, sourceState: 'degraded',
  sources: { status: 'healthy', claimed: 'missing', events: 'degraded', metrics: 'missing', claudeLane: 'missing', switches: 'healthy', drop: 'missing' },
  lastTick: '2026-10-31T00:00:00Z', paused: false, lanes: [lane('codex-personal', 0, 2, false)],
  memFreePct: 50, diskFreeGb: null, switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [], drop: { pending: [], done: 0 },
};
let dir: string;
let bin: string;
let children: ChildProcess[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'capacity-test-'));
  bin = join(dir, 'fake-phm');
  await writeFile(bin, `#!${process.execPath}\nimport { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const dir = process.env.FAKE_DIR;
appendFileSync(dir + '/requests', JSON.stringify(process.argv.slice(2)) + '\\n');
const sequence = JSON.parse(readFileSync(dir + '/sequence', 'utf8'));
let n = 0; try { n = Number(readFileSync(dir + '/count', 'utf8')); } catch {}
writeFileSync(dir + '/count', String(n + 1));
const item = sequence[Math.min(n, sequence.length - 1)];
if (item.hang) { writeFileSync(dir + '/pid', String(process.pid)); setInterval(() => {}, 1000); }
else if (item.fail) { process.stderr.write('fake-secret-credential'); process.exitCode = 7; }
else if (item.raw !== undefined) process.stdout.write(item.raw);
else process.stdout.write(JSON.stringify(item));
`);
  await chmod(bin, 0o755);
  children = [];
});
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
});
async function sequence(items: unknown[]) { await writeFile(join(dir, 'sequence'), JSON.stringify(items)); }
function run(args: string[]) {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, HOME: dir, FAKE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveDone => {
    child.on('close', code => resolveDone({ code, stdout, stderr }));
  });
  return { child, done };
}
async function requests() {
  try { return (await readFile(join(dir, 'requests'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
  catch { return []; }
}
async function waitForPid() {
  for (let i = 0; i < 300; i++) {
    try { return Number(await readFile(join(dir, 'pid'), 'utf8')); }
    catch { await new Promise(resolveWait => setTimeout(resolveWait, 20)); }
  }
  throw new Error('fake child did not start');
}

describe('agent capacity wait', { timeout: 60000 }, () => {
  it('validates every argument before launching and supports offline help', async () => {
    const help = await run(['--help', '--phm-bin', bin]).done;
    expect(help.code).toBe(0); expect(help.stdout).toContain('node scripts/agent-wait-capacity.mjs');
    for (const args of [['--help', '--bad'], ['--lane', '../bad'], ['--deadline-ms', '0'], ['--interval-ms', '60001'], ['--phm-bin'], ['--deadline-ms', '1', '--deadline-ms', '2']]) {
      const result = await run(['--phm-bin', bin, ...args]).done;
      expect(result.code).toBe(2);
    }
    expect(await requests()).toEqual([]);
  });
  it('polls unfiltered real-shaped snapshots and selects all matching usable lanes', async () => {
    await sequence([{ ...snapshot, paused: true }, { ...snapshot, lanes: [lane('codex-personal', 0, 2, false), lane('claude', 1, 3, false), lane('devin', 0, 1, false)] }]);
    const result = await run(['--phm-bin', bin, '--lane', 'codex-personal', '--lane', 'claude', '--deadline-ms', '3000', '--interval-ms', '10']).done;
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.outcome).toBe('capacity');
    expect(output.selected.map((row: { lane: string }) => row.lane)).toEqual(['codex-personal', 'claude']);
    expect(output.evidence.sources).toEqual(snapshot.sources);
    expect(output.evidence.lanes).toHaveLength(2);
    expect(await requests()).toEqual([['fleet', 'runs', '--json'], ['fleet', 'runs', '--json']]);
  });
  it('retains unknown and failed status evidence instead of inferring capacity', async () => {
    const invalid = { ...snapshot, sources: { ...snapshot.sources, status: 'degraded' }, paused: null,
      lanes: [lane('codex-personal', null, 2, false), lane('claude', 0, 0, false), lane('devin', 0, 2, true)] };
    await sequence([invalid]);
    const result = await run(['--phm-bin', bin, '--deadline-ms', '4000', '--interval-ms', '4000']).done;
    expect(result.code).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.outcome).toBe('deadline'); expect(output.selected).toEqual([]);
    expect(output.evidence.paused).toBeNull(); expect(output.evidence.sources.status).toBe('degraded');
    expect(output.evidence.lanes[0].running).toBeNull();
  });
  it('retries failures and sanitizes child errors at the deadline', async () => {
    await sequence([{ fail: true }]);
    const result = await run(['--phm-bin', bin, '--deadline-ms', '8000', '--interval-ms', '2000']).done;
    expect(result.code).toBe(1); expect(JSON.parse(result.stdout).evidence).toEqual({ error: 'CHILD_FAILED' });
    expect(result.stderr + result.stdout).not.toContain('fake-secret-credential');
    expect((await requests()).length).toBeGreaterThan(1);
  });
  it('reports malformed JSON, output overflow, and missing executable with stable codes', async () => {
    for (const [item, error] of [[{ raw: '{' }, 'INVALID_JSON'], [{ raw: 'x'.repeat(1024 * 1024 + 1) }, 'OUTPUT_LIMIT']] as const) {
      await sequence([item]);
      const result = await run(['--phm-bin', bin, '--deadline-ms', '10000', '--interval-ms', '10000']).done;
      expect(JSON.parse(result.stdout).evidence).toEqual({ error });
    }
    const missing = await run(['--phm-bin', join(dir, 'missing'), '--deadline-ms', '1000', '--interval-ms', '1000']).done;
    expect(JSON.parse(missing.stdout).evidence).toEqual({ error: 'SPAWN_FAILED' });
  });
  it('kills a hung child at deadline and on cancellation', async () => {
    await sequence([{ hang: true }]);
    const timeout = run(['--phm-bin', bin, '--deadline-ms', '4000']);
    const pid = await waitForPid();
    const result = await timeout.done;
    expect(result.code).toBe(1); expect(JSON.parse(result.stdout).evidence).toEqual({ error: 'CHILD_TIMEOUT' });
    expect(() => process.kill(pid, 0)).toThrow();
    await rm(join(dir, 'pid'));
    const cancel = run(['--phm-bin', bin, '--deadline-ms', '10000']);
    const cancelPid = await waitForPid();
    cancel.child.kill('SIGTERM');
    const cancelled = await cancel.done;
    expect(cancelled.code).toBe(143); expect(cancelled.stdout).toBe('');
    expect(() => process.kill(cancelPid, 0)).toThrow();
  });
});
