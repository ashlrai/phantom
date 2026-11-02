/**
 * RQ-PHX-SELFLOOPBUSPROGRESS02SOLJ1 — bus-progress integration for
 * `ashlr fleet self-loop`.  Tests:
 *
 *   • no flags → no bus writes
 *   • partial group rejected before ticking
 *   • completed passes produce readable envelopes
 *   • body omits sensitive report fields
 *   • duplicate delivery is accepted (idempotent, no re-write)
 *   • --stream and --bus composition runs each tick once
 *   • --help prints usage including bus flags
 *
 * Clocks, ticks, sleeps and the bus root are all faked; no real
 * provider, planner child, bus process, or machine state is touched.
 *
 * The 'full' / 'unavailable' transport paths are covered by the
 * existing bus-inbox tests (bus-inbox-oct31c, bus-inbox-capacity-etc);
 * bus-progress simply delegates to that transport.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfLoop } from '../src/cli/fleet-self-loop.js';
import {
  parseBusConfigGroup,
  buildProgressEnvelope,
  postProgressEnvelope,
  readDeliveredEnvelopes,
} from '../src/core/fleet/self-loop-bus-progress.js';
import type { SelfLoopTickOutcome } from '../src/core/fleet/self-loop.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'self-loop-bus-'));
  await mkdir(join(runsDir, 'queue'));
  await mkdir(join(runsDir, 'bus-root'), { recursive: true });
});
afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

const busRootFor = (label: string) => join(runsDir, 'bus-root', label);

interface Summary {
  v: number; startedAt: string; endedAt: string; elapsedMs: number;
  durationMs: number; intervalMs: number; ticks: number; failures: number;
  busy: number; termination: string; lastReport: Record<string, unknown> | null;
  observerError?: string;
}
type Deps = NonNullable<Parameters<typeof cmdFleetSelfLoop>[1]>;

const run = async (args: string[], deps: Deps = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetSelfLoop(args, {
    ...deps, output: (t) => out.push(t), error: (t) => err.push(t),
  });
  return { code, outLines: out, stderr: err.join('\n'),
    summary: (out.length === 1 && out[0]!.startsWith('{') ? JSON.parse(out[0]!) : null) as Summary | null };
};

const fakeClock = () => {
  let now = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); now += ms; };
  return { now: () => now, advance: (ms: number) => { now += ms; }, sleeps, sleep };
};

const recordingSteps = () => {
  const order: string[] = [];
  const stub = (name: string) => async () => {
    order.push(name);
    return { exitCode: 0, output: JSON.stringify({ ok: name }) };
  };
  return { order, steps: {
    'reset-release': stub('reset-release'),
    'lane-autohold': stub('lane-autohold'),
    'planner-tick': stub('planner-tick'),
  } };
};

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// --- parseBusConfigGroup tests --------------------------------------------

describe('parseBusConfigGroup', () => {
  it('accepts a valid group', () => {
    const result = parseBusConfigGroup('agent-supervisor', busRootFor('valid'), 'run-A');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.to).toBe('agent-supervisor');
      expect(result.value.runId).toBe('run-A');
    }
  });

  it('accepts all absent = inactive', () => {
    const result = parseBusConfigGroup(undefined, undefined, undefined);
    expect(result.ok).toBe(true);
  });

  it('rejects partial groups', () => {
    const cases: [string?, string?, string?][] = [
      ['label', undefined, undefined],
      [undefined, 'path', undefined],
      [undefined, undefined, 'id'],
      ['label', 'path', undefined],
      [undefined, 'path', 'id'],
      ['label', undefined, 'id'],
    ];
    for (const [to, root, id] of cases) {
      const result = parseBusConfigGroup(to, root, id);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects bad address values', () => {
    expect(parseBusConfigGroup('', busRootFor('x'), 'id').ok).toBe(false);
    expect(parseBusConfigGroup('a'.repeat(129), busRootFor('x'), 'id').ok).toBe(false);
    expect(parseBusConfigGroup('has space', busRootFor('x'), 'id').ok).toBe(false);
  });

  it('rejects bad bus-root', () => {
    expect(parseBusConfigGroup('to', 'relative/path', 'id').ok).toBe(false);
  });

  it('rejects bad bus-run-id', () => {
    expect(parseBusConfigGroup('to', busRootFor('x'), '').ok).toBe(false);
    expect(parseBusConfigGroup('to', busRootFor('x'), 'has space').ok).toBe(false);
  });
});

// --- buildProgressEnvelope tests ------------------------------------------

describe('buildProgressEnvelope', () => {
  it('produces a valid envelope with minimal fields', () => {
    const cfg = { to: 'obs', root: '/tmp/x', runId: 'r1' };
    const env = buildProgressEnvelope(cfg, 1, 0, 'ran', undefined, undefined);
    expect(env.from).toBe('fleet-self-loop');
    expect(env.to).toBe('obs');
    expect(env.priority).toBe('P2');
    expect(env.ttl).toBe(60 * 60 * 1000);
    expect(env.id).toBe('r1::pass-1');
    expect((env.body as Record<string, unknown>).kind).toBe('fleet-self-loop-pass');
    expect((env.body as Record<string, unknown>).runId).toBe('r1');
    expect((env.body as Record<string, unknown>).pass).toBe(1);
    expect((env.body as Record<string, unknown>).exitCode).toBe(0);
  });

  it('excludes raw reports, paths, and observer text', () => {
    const cfg = { to: 'obs', root: '/tmp/x', runId: 'r2' };
    const env = buildProgressEnvelope(
      cfg, 3, 1, 'failed', 2, 4000,
    );
    const body = env.body as Record<string, unknown>;
    expect(body.kind).toBeDefined();
    expect(body.runId).toBe('r2');
    expect(body.pass).toBe(3);
    expect(body.exitCode).toBe(1);
    expect(body.state).toBe('failed');
    expect(body.consecutiveFailures).toBe(2);
    expect(body.nextDelayMs).toBe(4000);
    const keys = Object.keys(body);
    for (const key of keys) {
      expect(key).not.toMatch(/report|exception|path|stdout|stderr|log|output/i);
    }
  });
});

// --- readDeliveredEnvelopes seam ------------------------------------------

describe('readDeliveredEnvelopes', () => {
  it('returns ok with empty messages for an empty root', () => {
    const emptyRoot = join(runsDir, 'empty-bus');
    const result = readDeliveredEnvelopes({ root: emptyRoot });
    expect(result.status).toBe('ok');
    expect(result.messages).toHaveLength(0);
  });
});

// --- Bus integration tests through cmdFleetSelfLoop -----------------------

describe('fleet self-loop bus-progress', () => {
  it('no bus flags produce no bus writes', async () => {
    const clock = fakeClock();
    const rec = recordingSteps();
    const testBusRoot = busRootFor('no-bus');
    await run(
      ['--json', '--duration-ms', '1', '--runs-dir', runsDir],
      { steps: rec.steps, now: clock.now, sleep: clock.sleep },
    );
    await flush();
    const page = readDeliveredEnvelopes({ root: testBusRoot });
    expect(page.status).toBe('ok');
    expect(page.messages).toHaveLength(0);
  });

  it('malformed partial bus group is rejected before ticking', async () => {
    let ticks = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => { ticks++; return { exitCode: 0, report: null }; };
    const { code, stderr } = await run(
      ['--duration-ms', '1', '--bus-to', 'obs', '--bus-root', busRootFor('partial')],
      { tick },
    );
    expect(code).toBe(2);
    expect(ticks).toBe(0);
    expect(stderr).toContain('Missing bus flags');
  });

  it('completed passes produce readable envelopes', async () => {
    const clock = fakeClock();
    const testBusRoot = busRootFor('integration');
    let tickNum = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => {
      // First pass fails (exitCode 1, state 'failed'), subsequent succeed.
      const isFirst = tickNum === 0;
      tickNum++;
      return {
        exitCode: isFirst ? 1 : 0,
        report: { state: isFirst ? 'failed' : 'ran' },
      };
    };
    await run(
      ['--json', '--duration-ms', '2500', '--interval-ms', '1000',
       '--runs-dir', runsDir,
       '--bus-to', 'test-agent', '--bus-root', testBusRoot,
       '--bus-run-id', 'integration-run'],
      { tick, now: clock.now, sleep: clock.sleep },
    );
    await flush();
    const page = readDeliveredEnvelopes({ root: testBusRoot });
    expect(page.status).toBe('ok');
    expect(page.messages).toHaveLength(3);  // 3 passes in 2500ms / 1000ms
    const bodies = page.messages.map(m => m.envelope.body as Record<string, unknown>);
    expect(bodies[0].kind).toBe('fleet-self-loop-pass');
    expect(bodies[0].runId).toBe('integration-run');
    expect(bodies[0].pass).toBe(1);
    expect(bodies[0].exitCode).toBe(1);
    expect(bodies[0].state).toBe('failed');
    expect(bodies[2].pass).toBe(3);
    expect(bodies[2].exitCode).toBe(0);
  });

  it('body omits sensitive report fields', async () => {
    const clock = fakeClock();
    const testBusRoot = busRootFor('secret');
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran', secretToken: 'SUPER_SECRET_123' } });
    await run(
      ['--json', '--duration-ms', '1', '--runs-dir', runsDir,
       '--bus-to', 'secret-test', '--bus-root', testBusRoot,
       '--bus-run-id', 'secret-run'],
      { tick, now: clock.now, sleep: clock.sleep },
    );
    await flush();
    const page = readDeliveredEnvelopes({ root: testBusRoot });
    expect(page.status).toBe('ok');
    expect(page.messages).toHaveLength(1);
    const bodyKeys = Object.keys(page.messages[0].envelope.body as Record<string, unknown>);
    for (const key of bodyKeys) {
      expect(key).not.toMatch(/secret|token|password|credential|key\b/i);
    }
  });

  it('duplicate delivery is accepted (idempotent, no re-write)', async () => {
    const clock = fakeClock();
    const testBusRoot = busRootFor('dup');
    const tick = async (): Promise<SelfLoopTickOutcome> =>
      ({ exitCode: 0, report: { state: 'ran' } });
    const { code: code1 } = await run(
      ['--json', '--duration-ms', '1', '--runs-dir', runsDir,
       '--bus-to', 'dup-test', '--bus-root', testBusRoot,
       '--bus-run-id', 'dup-run'],
      { tick, now: clock.now, sleep: clock.sleep },
    );
    expect(code1).toBe(0);
    await flush();
    // Second run: same run-id → duplicate. Accepted → code 0.
    const { code: code2 } = await run(
      ['--json', '--duration-ms', '1', '--runs-dir', runsDir,
       '--bus-to', 'dup-test', '--bus-root', testBusRoot,
       '--bus-run-id', 'dup-run'],
      { tick, now: clock.now, sleep: clock.sleep },
    );
    expect(code2).toBe(0);
    const page = readDeliveredEnvelopes({ root: testBusRoot });
    expect(page.status).toBe('ok');
    expect(page.messages).toHaveLength(1);  // same id, no duplicate envelope
  });

  it('--stream and --bus composition runs each tick once', async () => {
    const clock = fakeClock();
    const testBusRoot = busRootFor('stream');
    let tickNum = 0;
    const tick = async (): Promise<SelfLoopTickOutcome> => {
      tickNum++;
      return { exitCode: 0, report: { state: 'ran' } };
    };
    const { code, outLines } = await run(
      ['--stream', '--duration-ms', '2500', '--interval-ms', '1000',
       '--runs-dir', runsDir,
       '--bus-to', 'stream-test', '--bus-root', testBusRoot,
       '--bus-run-id', 'stream-run'],
      { tick, now: clock.now, sleep: clock.sleep },
    );
    expect(code).toBe(0);
    const passLines = outLines.filter(l => l.includes('"record":"pass"'));
    expect(passLines).toHaveLength(3);  // 3 passes in 2500ms / 1000ms
    await flush();
    const page = readDeliveredEnvelopes({ root: testBusRoot });
    expect(page.status).toBe('ok');
    expect(page.messages).toHaveLength(3);
  });

  it('--help prints usage including bus flags and exits 0 without ticking',
    async () => {
      let ticks = 0;
      const tick = async (): Promise<SelfLoopTickOutcome> => {
        ticks++;
        return { exitCode: 0, report: null };
      };
      const { code, outLines } = await run(['--help'], { tick });
      expect(code).toBe(0);
      expect(ticks).toBe(0);
      expect(outLines.join('\n')).toContain('bus-to');
      expect(outLines.join('\n')).toContain('bus-root');
      expect(outLines.join('\n')).toContain('bus-run-id');
    });
});
