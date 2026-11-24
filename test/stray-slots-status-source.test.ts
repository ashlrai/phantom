import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetStrayStop } from '../src/cli/fleet-stray-stop.js';
import { defaultStrayReaders, readStraySlots } from '../src/core/fleet/stray-slots.js';

const status = { schema: 'dispatchd.status.v1', paused: false, lanes: { claude: { running: 2, target: 8 }, codex: { running: 0, target: 1 } }, reaping: [], kept_worktrees: [] };

describe('stray-stop evidence from the daemon status file', () => {
  let home: string; let saved: string | undefined;
  const readers = { ...defaultStrayReaders, readProcesses: async () => [] };
  const runs = () => join(home, '.ashlr-runs');
  beforeEach(async () => {
    saved = process.env.HOME;
    home = await mkdtemp(join(tmpdir(), 'stray-status-'));
    process.env.HOME = home;
    await mkdir(join(runs(), 'metrics'), { recursive: true });
    await mkdir(join(runs(), 'queue'), { recursive: true });
    await writeFile(join(runs(), 'metrics/jobs.jsonl'), '');
  });
  afterEach(async () => { process.env.HOME = saved; await rm(home, { recursive: true, force: true }); });

  const run = async () => { const out: string[] = []; const code = await cmdFleetStrayStop(['--json'], { output: t => out.push(t), readStraySlots: () => readStraySlots(readers) }); return { code, json: JSON.parse(out[0]) }; };

  it('counts every lane in the current status shape and reports ok with no strays', async () => {
    await writeFile(join(runs(), 'queue/status.json'), JSON.stringify(status));
    const { code, json } = await run();
    expect(code).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.checked).toEqual({ lanes: 2, strays: 0 });
  });

  it('names the status file when it is missing', async () => {
    const { code, json } = await run();
    expect(code).toBe(1);
    expect(json.reason).toContain(`${join(runs(), 'queue/status.json')} is missing`);
  });

  it('says not JSON for a status file that is not JSON', async () => {
    await writeFile(join(runs(), 'queue/status.json'), 'half written');
    expect((await run()).json.reason).toContain('queue/status.json is not JSON');
  });

  it('says unexpected shape when lanes is not an object', async () => {
    await writeFile(join(runs(), 'queue/status.json'), JSON.stringify({ lanes: [] }));
    expect((await run()).json.reason).toContain('queue/status.json has an unexpected shape');
  });

  it('names the jobs ledger when a row is not JSON', async () => {
    await writeFile(join(runs(), 'queue/status.json'), JSON.stringify(status));
    await writeFile(join(runs(), 'metrics/jobs.jsonl'), 'not a row\n');
    expect((await run()).json.reason).toContain('metrics/jobs.jsonl is not JSON');
  });

  it('reads only the tail of an oversized ledger instead of failing', async () => {
    await writeFile(join(runs(), 'queue/status.json'), JSON.stringify(status));
    const row = JSON.stringify({ job: 'RQ-OLD', lane: 'claude', event: 'finish' }) + '\n';
    await writeFile(join(runs(), 'metrics/jobs.jsonl'), row.repeat(Math.ceil(9 * 1024 * 1024 / row.length)));
    expect((await run()).json.ok).toBe(true);
  });
});
