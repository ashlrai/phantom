import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdDoctorSupply } from '../src/cli/doctor-supply.js';
import { runAutofillTick } from '../src/core/fleet/autofill-run.js';
import { INGEST_JOB_HEADER, validateDropJob } from '../src/core/fleet/drop-job-writer.js';
import { readSupplyDoctor, supplyDoctorLines } from '../src/core/fleet/supply-doctor.js';

const NOW = Date.parse('2026-11-19T15:00:00');
let runs = '';
beforeEach(() => { runs = mkdtempSync(join(tmpdir(), 'supply-doctor-')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(runs, { recursive: true, force: true }); });

const row = (at: string, id: string, source: string) => `${at}\tRQ-PHX-${id}\t${source}\tclaude\twork\tGoal: something`;
function seedDrop(rows: string[], done: string[] = []): void {
  mkdirSync(join(runs, 'leader', 'drop', 'done'), { recursive: true });
  writeFileSync(join(runs, 'leader', 'drop', 'ingested.tsv'), `${rows.join('\n')}\n`);
  for (const name of done) writeFileSync(join(runs, 'leader', 'drop', 'done', name), 'x');
}
const read = (readOff: () => Promise<boolean | null> = async () => false) => readSupplyDoctor({ runsDir: runs, now: () => NOW, readOff, readCandidates: async () => ({ noChange: 1, published: 4 }) });

describe('phm doctor supply', () => {
  it('Core-only rows give the not-landed verdict, per-source last ingest and 24 h counts', async () => {
    seedDrop([
      row('2026-11-18 09:00:00', 'OLDONE', 'claude'),
      row('2026-11-19 13:00:00', 'ONE', 'claude'),
      row('2026-11-19 14:00:00', 'TWO', 'sol'),
      row('2026-11-19 14:30:00', 'THREE', 'claude'),
    ]);
    const report = await read();
    expect(report.verdict).toBe('self-supply has not landed a job in 24 h');
    expect(report.selfSupply).toEqual({ landed24h: 0, lastLanded: null });
    expect(report.candidates).toEqual({ state: 'known', noChange: 1, published: 4 });
    expect(supplyDoctorLines(report)).toContain('Gap candidates now: 1 from no-change jobs, 4 from published jobs.');
    const blind = await readSupplyDoctor({ runsDir: runs, now: () => NOW, readOff: async () => false, readCandidates: async () => null });
    expect(blind.candidates).toEqual({ state: 'unknown', why: 'job metrics unreadable' });
    expect(report.ingested).toMatchObject({ state: 'known', sources: [
      { source: 'claude', lastIngest: '2026-11-19 14:30:00', count24h: 2 },
      { source: 'sol', lastIngest: '2026-11-19 14:00:00', count24h: 1 },
    ] });
  });

  it('a gap row clears the verdict (gap ids are recognised under the claude source)', async () => {
    seedDrop([row('2026-11-19 14:00:00', 'ONE', 'claude'), row('2026-11-19 14:40:00', 'GAP0123456789', 'claude')]);
    const report = await read();
    expect(report.verdict).toBe('self-supply landed 1 job in 24 h (last 2026-11-19 14:40:00)');
    expect(report.ingested.state === 'known' && report.ingested.sources[0]).toMatchObject({ source: 'gap', count24h: 1 });
  });

  it('says why when the hook is off or unknown', async () => {
    seedDrop([row('2026-11-19 14:00:00', 'ONE', 'claude')]);
    expect((await read(async () => true)).verdict).toContain('hook is off');
    expect((await read(async () => null)).verdict).toContain('hook state is unknown');
    expect((await read(async () => false)).hook.enabled).toBe(true);
  });

  it('counts rejected drops from the last 24 h by reason', async () => {
    seedDrop([], ['RQ-PHX-AAA.md.bad-header', 'RQ-PHX-BBB.md.bad-header', 'RQ-PHX-CCC.md.too-large', 'notes.txt']);
    const report = await read();
    // Files were just written: relative to the fixed NOW they are in the future, so none count.
    expect(report.rejected).toMatchObject({ state: 'known', total24h: 0 });
    const later = await readSupplyDoctor({ runsDir: runs, now: () => Date.now() + 1000, readOff: async () => false });
    expect(later.rejected).toMatchObject({ state: 'known', total24h: 3, byReason: { 'bad-header': 2, 'too-large': 1 } });
  });

  it('reads missing files as unknown and names the path', async () => {
    const report = await read();
    expect(report.ingested).toMatchObject({ state: 'unknown', why: 'missing', path: join(runs, 'leader', 'drop', 'ingested.tsv') });
    expect(report.rejected).toMatchObject({ state: 'unknown', path: join(runs, 'leader', 'drop', 'done') });
    expect(report.selfSupply.landed24h).toBeNull();
    expect(report.verdict).toContain(`self-supply is unknown: cannot read ${join(runs, 'leader', 'drop', 'ingested.tsv')}`);
    expect(supplyDoctorLines(report).join('\n')).toContain('Rejected drops: unknown');
  });

  it('prints plain words or one JSON line and rejects bad flags', async () => {
    seedDrop([row('2026-11-19 14:00:00', 'ONE', 'claude')]);
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(m); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdDoctorSupply(['--json'], read)).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ schema: 'doctor.supply.v1' });
    expect(await cmdDoctorSupply([], read)).toBe(0);
    expect(out[0]).toBe('self-supply has not landed a job in 24 h');
    expect(await cmdDoctorSupply(['--nope'], read)).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});

describe('self-tick gap hook writes a drop file into the configured drop dir', () => {
  it('a starved lane + a finished job with a gap becomes a valid RQ-PHX-GAP file the doctor can read back', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'supply-wt-'));
    const root = mkdtempSync(join(tmpdir(), 'supply-root-'));
    try {
      vi.stubEnv('ASHLR_WT_DIR', wt);
      mkdirSync(join(runs, 'metrics'), { recursive: true });
      mkdirSync(join(runs, 'queue'), { recursive: true });
      writeFileSync(join(runs, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ event: 'outcome', job: 'RQ-A', lane: 'claude', empty: true, repo: 'phantom', ts: new Date(NOW - 3_600_000).toISOString() })}\n`);
      mkdirSync(join(wt, 'RQ-A'), { recursive: true });
      writeFileSync(join(wt, 'RQ-A', 'BRIDGE_NOTES.md'), '## Remaining gaps\n- Wire the digest into the weekly report\n');
      const report = await runAutofillTick({
        runsDir: runs, apply: true, now: () => NOW, root, entries: [], readOff: async () => false,
        readLanes: async () => ({ starved: ['claude'], counts: { claude: { running: 0, target: 8, queued: 0 } } }),
        fill: async () => ({ error: 'no-target' }),
      });
      expect(report.gaps).toMatchObject({ queued: 1, unknown: false });
      const dir = join(runs, 'leader', 'drop', 'claude');
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const id = /^RQ-PHX-(GAP[0-9A-F]{10})\.md$/.exec(files[0]!)?.[1];
      expect(id).toBeTruthy();
      const text = readFileSync(join(dir, files[0]!), 'utf8');
      const lines = text.split('\n');
      expect(INGEST_JOB_HEADER.test(lines[0]!)).toBe(true);
      expect(validateDropJob({ id, repo: 'phantom', lane: 'claude', tier: 'work', body: lines.slice(2).join('\n').trimEnd() })).toEqual({ ok: true });
      expect(text).toContain('Wire the digest into the weekly report');
      // Once the ingest records it, the doctor calls it landed.
      seedDrop([`2026-11-19 14:50:00\tRQ-PHX-${id}\tclaude\tclaude\twork\tGoal: Wire the digest`]);
      expect((await read()).verdict).toContain('self-supply landed 1 job');
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('supply doctor self-held lanes', () => {
  const stamp = (min: number, body: string): string => {
    const d = new Date(NOW - min * 60_000); const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${body}`;
  };
  const events = [10, 20, 30].flatMap((m, i) => [stamp(m + 1, `LAUNCH J${i} phantom zai mid`), stamp(m, `LAUNCH_DEFERRED J${i} HELD (requeued, backoff 1800s)`)]).join('\n');
  const base = { runsDir: runs, now: () => NOW, readOff: async () => false, readCandidates: async () => null };
  it('lists a self-held lane in the report and the plain lines', async () => {
    const report = await readSupplyDoctor({ ...base, readEvents: async () => events });
    expect(report.selfHeld).toMatchObject({ state: 'known', windowMinutes: 60, lanes: [{ lane: 'zai', held: 3, finishes: 0 }] });
    expect(supplyDoctorLines(report)).toContain('Self-held lane: lane zai holds every launch (3 in 60 min); skipped until a launch there finishes.');
  });
  it('says none, or unknown when the log is unreadable', async () => {
    expect((await readSupplyDoctor({ ...base, readEvents: async () => '' })).selfHeld).toMatchObject({ state: 'known', lanes: [] });
    const blind = await readSupplyDoctor({ ...base, readEvents: async () => null });
    expect(blind.selfHeld.state).toBe('unknown');
    expect(supplyDoctorLines(blind).join('\n')).toMatch(/Self-held lanes: unknown/);
  });
});
