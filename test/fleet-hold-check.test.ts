/** fleet-hold-check.test.ts — `phm fleet hold-check`: HOLD, held lanes and usage eligibility. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { checkFleetHold, cmdFleetHoldCheck } from '../src/cli/fleet-hold-check.js';

let dir: string;
const row = (target: number, extra: Record<string, unknown> = {}) => ({ target, floor: 0, ceiling: 12, ...extra });

async function setup(files: { slots?: unknown; resources?: unknown; hold?: boolean }) {
  await mkdir(join(dir, 'queue'), { recursive: true });
  const put = (name: string, v: unknown) => writeFile(join(dir, name), typeof v === 'string' ? v : JSON.stringify(v));
  if (files.slots !== undefined) await put('queue/slots.json', files.slots);
  if (files.resources !== undefined) await put('queue/resources.json', files.resources);
  if (files.hold) await put('HOLD', 'owner hold');
}

async function run(args: string[] = []) {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdFleetHoldCheck(args, { runsDir: dir });
  return { code, out: logs.join('\n') };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hold-check-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe('fleet hold-check', () => {
  it('is registered', () => { expect(FLEET_SUBCOMMAND_LOADERS['hold-check']).toBeTypeOf('function'); });

  it('reports held lanes and usage eligibility', async () => {
    await setup({
      hold: true,
      slots: { aa: row(2, { held: true, held_reason: 'quota' }), bb: row(1), cc: row(1), dd: row(1) },
      resources: { aa: { used_frac: 1.2 }, bb: { used_frac: 0.3 }, cc: { used_frac: 'nope' } },
    });
    const view = await checkFleetHold({ runsDir: dir });
    expect(view.hold).toBe(true);
    expect(view.heldLanes).toEqual(['aa']);
    expect(view.lanes.map(l => [l.lane, l.usage])).toEqual([
      ['aa', 'exhausted'], ['bb', 'eligible'], ['cc', 'unknown'], ['dd', 'unknown']]);
    const { code, out } = await run();
    expect(code).toBe(1);
    expect(out).toContain('HOLD: on');
    expect(out).toContain('aa: held (quota); usage exhausted');
  });

  it('exits 0 with nothing held and --json output parses', async () => {
    await setup({ slots: { bb: row(1) }, resources: { lanes: { bb: { used_frac: 0.1 } } } });
    const { code, out } = await run(['--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ schema: 'fleet.hold-check.v1', hold: false, usageSource: 'healthy', heldLanes: [] });
  });

  it.each([['missing', undefined], ['malformed', '{not json'], ['array', '[]']])('treats %s usage as unknown', async (_n, resources) => {
    await setup({ slots: { bb: row(1) }, resources });
    const view = await checkFleetHold({ runsDir: dir });
    expect(view.usageSource).toBe(resources === undefined ? 'missing' : 'unreadable');
    expect(view.lanes[0]!.usage).toBe('unknown');
    expect((await run()).out).toContain('usage is unknown for every lane');
  });

  it('honors ASHLR_RUNS_DIR', async () => {
    await setup({ slots: { bb: row(1, { held: true }) } });
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    try { expect((await checkFleetHold()).heldLanes).toEqual(['bb']); } finally { vi.unstubAllEnvs(); }
  });

  it('rejects unknown arguments and prints help', async () => {
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['--help'])).code).toBe(0);
  });
});
