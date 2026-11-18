import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirtyLandedPr } from '../src/core/fleet/dirty-landed-inspect.js';
import { RECUT_AREAS, type GitRun } from '../src/core/fleet/recut-gate.js';
import { eligibleRecutPrs, planRecutArea, promptTask, recutTaskLine, withTaskLine } from '../src/core/fleet/recut-plan.js';
import { cmdRecut } from '../src/cli/recut-check.js';

const now = Date.parse('2026-11-18T00:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);
const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'recut-plan-')); dirs.push(dir); return dir; };
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.unstubAllEnvs(); });
const git: GitRun = async args => args[0] === 'log' ? { code: 0, stdout: '' } : { code: 128, stdout: '' };

const pr = (number: number, remainingPaths: string[], extra: Partial<DirtyLandedPr> = {}): DirtyLandedPr => ({
  number, title: 'bridge: RQ-PHX-FAKE', head: 'a'.repeat(40), base: 'master', class: 'needs-recut',
  changedPaths: remainingPaths, landedPaths: [], remainingPaths, ...extra,
});

/** A temp root with a metrics ledger, a saved dirty-landed report and an optional stop file. */
function fixture(opts: { jobs?: string[]; prs?: DirtyLandedPr[]; complete?: boolean; stop?: string } = {}) {
  const root = scratch();
  mkdirSync(join(root, 'home'));
  vi.stubEnv('HOME', join(root, 'home'));
  const metrics = join(root, 'jobs.jsonl'), prs = join(root, 'dirty.json');
  writeFileSync(metrics, opts.jobs?.length ? `${opts.jobs.join('\n')}\n` : '');
  writeFileSync(prs, JSON.stringify({ schema: 'fleet.dirty-landed.v1', repo: 'ashlrai/phantom', generatedAt: at(0), open: 3, dirty: 3,
    complete: opts.complete ?? true, counts: {}, prs: opts.prs ?? [] }));
  if (opts.stop !== undefined) {
    writeFileSync(join(root, 'stop.tsv'), opts.stop);
    vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(root, 'stop.tsv'));
  } else vi.stubEnv('ASHLR_JOBS_STOP_FILE', '');
  return { root, metrics, prs };
}

async function plan(args: string[], f: { metrics: string; prs: string }) {
  const out: string[] = [], err: string[] = [];
  const code = await cmdRecut(['plan', '--metrics', f.metrics, '--prs', f.prs, ...args], { git, now, output: t => out.push(t), error: t => err.push(t) });
  return { code, out, err };
}
const areaOf = (report: { areas: { area: string }[] }, area: string) => report.areas.find(a => a.area === area);

describe('recut task line', () => {
  const prompt = '# Goal: land one stranded bridge PR that touches src/core\n\nStep one: look.\nStep two: land it.\n';
  const line = recutTaskLine({ id: 'RQ-PHX-RECUTCOREC9', lane: 'claude', tier: 'frontier', repo: 'phantom', task: promptTask(prompt)! })!;

  it('is the first non-blank line, in the form the launch precheck reads, and the rest is unchanged', () => {
    const text = withTaskLine(`\n\n${prompt}`, line, 'RQ-PHX-RECUTCOREC9');
    const lines = text.split('\n');
    expect(lines.find(l => l.trim())).toBe('RQ-PHX-RECUTCOREC9 (P1, pool=claude, tier=frontier, repo=phantom): land one stranded bridge PR that touches src/core');
    expect(lines.filter(l => l.startsWith('RQ-PHX-RECUTCOREC9 ('))).toHaveLength(1);
    expect(lines[0]).toMatch(/^RQ-PHX-RECUTCOREC9 \(([^)]*)\):\s*(.{16,})$/);
    expect(text.slice(line.length + 2)).toBe(prompt);
  });
  it('is not added twice', () => {
    const once = withTaskLine(prompt, line, 'RQ-PHX-RECUTCOREC9');
    expect(withTaskLine(once, line, 'RQ-PHX-RECUTCOREC9')).toBe(once);
  });
  it('refuses fields that would break the line', () => {
    const ok = { id: 'RQ-PHX-RECUTCOREC9', lane: 'claude', tier: 'frontier', repo: 'phantom', task: 'land one stranded bridge PR' };
    expect(recutTaskLine({ ...ok, lane: 'a, b' })).toBeNull();
    expect(recutTaskLine({ ...ok, id: 'rq bad' })).toBeNull();
    expect(recutTaskLine({ ...ok, task: 'too short' })).toBeNull();
    expect(recutTaskLine({ ...ok, task: 'land one\nstranded   bridge PR' })).toBe('RQ-PHX-RECUTCOREC9 (P1, pool=claude, tier=frontier, repo=phantom): land one stranded bridge PR');
  });
  it('phm recut prompt prints the prompt with the task line first', async () => {
    const out: string[] = [];
    const code = await cmdRecut(['prompt', 'RQ-PHX-RECUTCOREC9', '--lane', 'claude', '--tier', 'frontier'],
      { input: async () => prompt, output: t => out.push(t), error: t => out.push(t) });
    expect(code).toBe(0);
    expect(out).toEqual([`${line}\n\n${prompt.slice(0, -1)}`]);
    expect(await cmdRecut(['prompt', 'RQ-PHX-RECUTCOREC9', '--lane', 'claude'], { input: async () => prompt, error: () => {} })).toBe(2);
    expect(await cmdRecut(['prompt', 'RQ-PHX-RECUTCOREC9', '--lane', 'claude', '--tier', 'frontier'], { input: async () => '  \n', error: () => {} })).toBe(2);
  });
});

describe('eligible PRs', () => {
  it('counts only PRs the recut sweep would write that touch the area', () => {
    const prs = [pr(1, ['src/core/a.ts']), pr(2, ['docs/a.md']), pr(3, ['src/core/b.ts'], { class: 'landed' }),
      pr(4, ['src/core/c.ts'], { title: 'feat: other' }), pr(5, ['src/coreish/x.ts'])];
    expect(eligibleRecutPrs(prs, 'CORE', now)).toEqual([1]);
    expect(eligibleRecutPrs(prs, 'DOCS', now)).toEqual([2]);
    expect(eligibleRecutPrs(prs, 'WEBUI', now)).toEqual([]);
  });
  it('treats an unknown or cut-short list as unknown, never zero', () => {
    const gate = { emit: true, code: 'emit' as const, reason: 'no skip rule matched' };
    expect(planRecutArea('WEBUI', 'RQ-PHX-RECUTWEBUI', gate, { prs: null, complete: false }, now)).toMatchObject({ emit: true, eligible: null });
    expect(planRecutArea('WEBUI', 'RQ-PHX-RECUTWEBUI', gate, { prs: [], complete: false }, now)).toMatchObject({ emit: true, eligible: null });
    expect(planRecutArea('WEBUI', 'RQ-PHX-RECUTWEBUI', gate, { prs: [], complete: true }, now))
      .toEqual({ area: 'webui', family: 'RQ-PHX-RECUTWEBUI', emit: false, code: 'no-eligible-pr', reason: 'no eligible PR touches webui', eligible: 0, prs: [] });
  });
});

describe('phm recut plan', () => {
  const corePrs = [pr(7, ['src/core/a.ts']), pr(8, ['src/web-ui/b.tsx'])];

  it('skips an area the gate rejects, with one plain line', async () => {
    const jobs = Array.from({ length: 6 }, (_, i) => [row({ event: 'launch', job: `RQ-PHX-RECUTCOREC${561 + i}`, repo: 'phantom', ts: at(8 - i) }),
      row({ event: 'finish', job: `RQ-PHX-RECUTCOREC${561 + i}`, empty: true, ts: at(7 - i) })]).flat();
    const { code, out } = await plan(['core', 'webui'], fixture({ jobs, prs: corePrs }));
    expect(code).toBe(0);
    expect(out).toEqual(['skip core: RQ-PHX-RECUTCORE is on the yield stop list', 'emit webui: 1 eligible PR; no skip rule matched']);
  });

  it('skips an area a live stop-file row matches and ignores an expired row', async () => {
    const live = Math.floor(now / 1000) + 3600, gone = Math.floor(now / 1000) - 60;
    const stop = `# hand rows\n^RQ-PHX-RECUTCORE(C[0-9]+)?$\t${live}\tcore-empty\n^RQ-PHX-RECUTWEBUI(C[0-9]+)?$\t${gone}\told-row\n`;
    const { out } = await plan(['--json', 'core', 'webui'], fixture({ prs: corePrs, stop }));
    const report = JSON.parse(out[0]!);
    expect(report.stop_file).toBe('read');
    expect(areaOf(report, 'core')).toMatchObject({ emit: false, code: 'stop-file', eligible: 1, prs: [7] });
    expect(areaOf(report, 'core').reason).toContain('core-empty');
    expect(areaOf(report, 'webui')).toMatchObject({ emit: true, code: 'emit', eligible: 1, prs: [8] });
  });

  it('skips every area no eligible PR touches', async () => {
    const { out } = await plan(['--json'], fixture({ prs: corePrs }));
    const report = JSON.parse(out[0]!);
    expect(report.areas.map((a: { area: string }) => a.area)).toEqual(RECUT_AREAS.map(a => a.toLowerCase()));
    expect(areaOf(report, 'docs')).toMatchObject({ emit: false, code: 'no-eligible-pr', eligible: 0 });
    expect(report.areas.filter((a: { emit: boolean }) => a.emit).map((a: { area: string }) => a.area))
      .toEqual(['core', 'webui', 'desk', 'src']);
    expect(report).toMatchObject({ emit: 4, skip: RECUT_AREAS.length - 4, prs: { source: 'file', known: true, complete: true } });
  });

  it('keeps an unreadable PR list unknown and follows the gate alone', async () => {
    const f = fixture();
    const { out } = await plan(['--json', 'docs'], { ...f, prs: join(f.root, 'missing.json') });
    const report = JSON.parse(out[0]!);
    expect(report.prs).toEqual({ source: 'file', known: false, complete: null });
    expect(report.areas[0]).toMatchObject({ area: 'docs', emit: true, eligible: null, prs: null });
    expect(report.stop_file).toBe('unset');
  });

  it('--json has schema and version and writes nothing', async () => {
    const f = fixture({ prs: corePrs, stop: '# none\n' });
    const snapshot = () => readdirSync(f.root, { recursive: true }).map(String).sort()
      .map(name => { const s = statSync(join(f.root, name)); return `${name}:${s.size}:${s.mtimeMs}`; });
    const before = snapshot();
    const { code, out, err } = await plan(['--json'], f);
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'recut.plan.v1', version: 1, generated_at: at(0) });
    expect(snapshot()).toEqual(before);
  });

  it('rejects bad usage', async () => {
    const f = fixture();
    expect((await plan(['nowhere'], f)).code).toBe(2);
    expect((await plan(['--prs', 'x'], f)).code).toBe(2);
    expect(await cmdRecut(['plan', '--help'], { output: () => {} })).toBe(0);
  });
});


it('keeps malformed saved PR evidence unknown instead of crashing or skipping', async () => {
  const f = fixture();
  writeFileSync(f.prs, JSON.stringify({schema:'fleet.dirty-landed.v1',complete:true,prs:[{base:'master',title:'bridge: RQ-PHX-FAKE',class:'needs-recut'}]}));
  const { code, out } = await plan(['--json','core'], f);
  expect(code).toBe(0);
  expect(JSON.parse(out[0]!)).toMatchObject({prs:{known:false,complete:null},areas:[{area:'core',emit:true,eligible:null}]});
});
