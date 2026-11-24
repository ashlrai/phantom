import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';

it('keeps a manual hold across ledger fallback and unreadable decision evidence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reset-original-'));
  const root = join(home, 'runs');
  const slots = join(root, 'queue/slots.json');
  const status = join(root, 'queue/status.json');
  const quota = join(root, 'metrics/claude-quota.json');
  const held = JSON.stringify({ claude: { target: 1, floor: 0, ceiling: 2, held: true,
    held_reason: 'manual: operator pause', last_change: Date.parse('2026-11-20T12:00:00Z') / 1000 } });
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.filter(name => name !== 'reset-release')
    .map(name => [name, async () => ({ exitCode: 0, output: '{}' })])) as Partial<SelfTickSteps>;
  const tick = async () => {
    const output: string[] = [];
    const code = await cmdFleetSelfTick(['--json', '--apply', '--runs-dir', root], {
      home, now: () => Date.parse('2026-11-21T12:00:00Z'), steps,
      claudeFindCommand: () => null, output: text => output.push(text), error: () => undefined,
    });
    const report = JSON.parse(output[0]!) as { steps: { step: string; state: string; report: Record<string, unknown> }[] };
    return { code, release: report.steps.find(step => step.step === 'reset-release')! };
  };
  try {
    await mkdir(join(root, 'queue'), { recursive: true });
    await writeFile(slots, held);
    await writeFile(status, JSON.stringify({ last_tick: '2026-11-21T11:59:00Z',
      lanes: { claude: { held: true } }, budget: { claude: { weekly_used_pct: 3,
        reset_at: '2026-11-21T11:00:00Z', observed_at: '2026-11-21T11:30:00Z' } } }));
    const healthy = await tick();
    expect(healthy.code).toBe(0);
    expect(healthy.release).toMatchObject({ state: 'ok', report: { sourceState: 'healthy',
      claudeProbe: 'unavailable', claudeQuota: { state: 'ledger', source: 'ledger', weeklyPct: 3,
        observedAt: '2026-11-21T11:59:00Z' }, released: [] } });
    expect(await readFile(slots, 'utf8')).toBe(held);
    await expect(stat(quota)).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(status, '{invalid');
    const unreadable = await tick();
    expect(unreadable.code).toBe(1);
    expect(unreadable.release).toMatchObject({ state: 'failed', report: { sourceState: 'degraded',
      released: [], problems: ['the dispatcher status file (queue/status.json) is unreadable'] } });
    expect(await readFile(slots, 'utf8')).toBe(held);
    await expect(stat(quota)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
