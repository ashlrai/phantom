import { mkdtemp, mkdir, rm, writeFile, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetParkAudit, readParkAudit } from '../src/cli/fleet-park-audit.js';

const dirs: string[] = [];
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'park-audit-')); dirs.push(dir);
  await mkdir(join(dir, 'queue'));
  return dir;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('fleet park-audit', () => {
  it('counts both queue layouts, orders the oldest ten, and reports unknown ages', async () => {
    const dir = await fixture();
    const rows: string[] = [];
    for (let i = 0; i < 12; i++) {
      const path = join(dir, 'queue', `${i}.md`);
      await writeFile(path, 'private prompt');
      await utimes(path, i + 1, i + 1);
      rows.push(i % 2 ? `PARKED-DEP.lane\tJOB-${i}\tlane\twork\trepo\t${path}` : `JOB-${i}\trepo\tPARKED-HOLD.lane\twork\t${i}.md`);
    }
    rows.push('JOB-MISSING\trepo\tPARKED-DEP.lane\twork\tmissing.md', 'JOB-READY\trepo\tlane\twork\tx');
    await writeFile(join(dir, 'queue', 'ready.tsv'), rows.join('\n'));
    const result = await readParkAudit(dir);
    expect(result).toMatchObject({ source: 'healthy', parked: 13, unknownAge: 1, reasons: [{ reason: 'DEP', count: 7 }, { reason: 'HOLD', count: 6 }] });
    expect(result.oldest.map(row => row.job)).toEqual(Array.from({ length: 10 }, (_, i) => `JOB-${i}`));
    expect(JSON.stringify(result)).not.toContain('private prompt');
    expect(JSON.stringify(result)).not.toContain(dir);
  });

  it('handles headers, invalid ids, missing and symlinked prompts', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue', 'p.md'), 'x');
    await symlink(join(dir, 'queue', 'p.md'), join(dir, 'queue', 'link.md'));
    await writeFile(join(dir, 'queue', 'ready.tsv'), 'job\tstatus\tproject\tprompt\nOK\tPARKED-DEP.x\trepo\tlink.md\nBAD/ID\tPARKED-HOLD.x\trepo\tp.md\n');
    expect(await readParkAudit(dir)).toMatchObject({ source: 'degraded', parked: 1, unknownAge: 1, malformed: 1, oldest: [] });
  });

  it('reports missing queue as unknown and exposes JSON and help through the CLI', async () => {
    const dir = await fixture();
    expect(await readParkAudit(dir)).toMatchObject({ source: 'missing', parked: null, unknownAge: null });
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetParkAudit(['--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]![0])).source).toBe('missing');
    expect(await cmdFleetParkAudit(['--help'])).toBe(0);
    expect(await cmdFleetParkAudit(['--bogus'])).toBe(2);
    vi.unstubAllEnvs();
  });
});
