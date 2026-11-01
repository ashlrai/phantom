import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseReadyTsv } from './lane-console.js';
import { readReadySupply, summarizeReadySupply } from './ready-supply.js';

const now = () => new Date('2026-11-01T00:00:00Z');
const dirs: string[] = [];
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ready-supply-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue'));
  return dir;
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('ready supply', () => {
  it('summarizes lanes in order, including idless and dotted parked rows', () => {
    const parsed = parseReadyTsv([
      'id\tstatus\tpool',
      'RQ-PHX-Z\tPARKED-BYHAND\tzeta',
      'RQ-PHX-FIRST\tREADY\tzeta',
      'RQ-PHX-SECOND\tREADY\tzeta',
      '\tREADY\talpha',
      'RQ-OTHER\tREADY\tPARKED-BYHAND.codex-local',
      'RQ-PHX-PARK\tREADY\tPARKED-BYHAND.codex-local',
      'RQ-OTHER-2\tRUNNING\tzeta',
      'bad id\tREADY\tzeta',
    ].join('\n'));
    const result = summarizeReadySupply(parsed.rows, { dropped: parsed.dropped, sourceState: 'healthy', now });
    expect(result).toEqual({
      v: 1, generatedAt: '2026-11-01T00:00:00.000Z', sourceState: 'healthy', rows: 7, dropped: 1,
      lanes: [
        { lane: 'alpha', phxReady: 0, phxParked: 0, fillerReady: 1, fillerParked: 0, oldestPhxId: null },
        { lane: 'codex-local', phxReady: 0, phxParked: 1, fillerReady: 0, fillerParked: 1, oldestPhxId: null },
        { lane: 'zeta', phxReady: 2, phxParked: 1, fillerReady: 1, fillerParked: 0, oldestPhxId: 'RQ-PHX-FIRST' },
      ],
      totals: { phxReady: 2, phxParked: 2, fillerReady: 2, fillerParked: 1 },
    });
  });

  it('reads the real headerless five-column forms and normal positional rows', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue', 'ready.tsv'), [
      'RQ-MR-DRIP-RATE\tnone\tPARKED-BYHAND.codex-local\twork\t/abs/path.md',
      'RQ-PHX-LANEHOLDPLACE01\tphantom\tdevin\twork\t/abs/path.md',
      'RQ-PHX-NEXT\tdevin\ttier\trepo\ttitle',
      'RQ-OTHER\tother-repo\tdevin\twork\t/abs/other.md',
    ].join('\n'));
    const result = await readReadySupply({ runsDir: dir, now });
    expect(result.sourceState).toBe('healthy');
    expect(result.rows).toBe(4);
    expect(result.lanes).toEqual([
      { lane: 'codex-local', phxReady: 0, phxParked: 0, fillerReady: 0, fillerParked: 1, oldestPhxId: null },
      { lane: 'devin', phxReady: 2, phxParked: 0, fillerReady: 1, fillerParked: 0, oldestPhxId: 'RQ-PHX-LANEHOLDPLACE01' },
    ]);
  });

  it('reports missing and degraded sources without throwing', async () => {
    const dir = await fixture();
    expect((await readReadySupply({ runsDir: dir, now })).sourceState).toBe('missing');
    await writeFile(join(dir, 'queue', 'ready.tsv'), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect((await readReadySupply({ runsDir: dir, now })).sourceState).toBe('degraded');
    await rm(join(dir, 'queue', 'ready.tsv'));
    await mkdir(join(dir, 'queue', 'ready.tsv'));
    expect((await readReadySupply({ runsDir: dir, now })).sourceState).toBe('degraded');
    expect((await readReadySupply({ runsDir: dir, now: () => { throw new Error('clock'); } })).sourceState).toBe('degraded');
  });

  it('uses ASHLR_RUNS_DIR when no directory is supplied', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue', 'ready.tsv'), 'RQ-PHX-X\tdevin\n');
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    expect((await readReadySupply({ now })).totals.phxReady).toBe(1);
  });
});
