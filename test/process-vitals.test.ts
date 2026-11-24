import { expect, it, vi } from 'vitest';
import { readProcessVitals, type ProcessVitalsIo } from '../src/core/fleet/process-vitals.js';
import { sanitizePublicJson } from '../src/core/util/public-json.js';

const date = 'Mon Nov 16 12:00:00 2026', now = Date.parse(date) + 180_000;
const boot = '12345678-1234-1234-1234-123456789abc';
const start = Math.floor(Date.parse(date) / 1000).toString(16).padStart(64, '0');
const ps = (pid: number, ppid = 1, executable = '/usr/bin/node', uid = 501) => `${pid} ${ppid} ${uid} ${pid} ${pid * 10} ${date} ${executable}`;
function fixture() {
  const files = new Map([
    ['/runs/metrics/jobs.jsonl', JSON.stringify({ job: 'RQ-DONE', event: 'outcome', state: 'MERGED', ts: new Date(now - 90_000).toISOString() })],
    ['/runs/queue/run/resource-sessions/RQ-DONE.json', JSON.stringify({ schemaVersion: 1, jobId: 'RQ-DONE', rootPid: 10, startSource: 'ps-lstart', start, bootId: boot, ownerWitness: 'a'.repeat(64) })],
  ]);
  const outputs = new Map<string, string | null>([
    ['/bin/ps', [ps(10), ps(11, 1, '/Applications/Editor.app/Contents/MacOS/Editor'), ps(12), ps(13), ps(14), ps(15, 13), ps(16), ps(17, 11)].join('\n')],
    ['/usr/sbin/lsof', [10, 11, 15, 16, 17].map(p => `p${p}\nn/home/Projects/ashlrai/wt/${p === 15 ? 'RQ-LIVE/src' : 'RQ-DONE'}`).join('\n')],
    ['/bin/launchctl', '12 0 ai.ashlr.main-guardian\n13 0 ai.ashlr.daemon'], ['/usr/sbin/sysctl', boot],
  ]);
  const io: ProcessVitalsIo = { home: '/home', uid: 501, now: () => now, run: vi.fn(async file => outputs.get(file) ?? null), read: file => files.get(file) ?? null, signal: vi.fn() };
  return { io, outputs, files, read: (apply?: string) => readProcessVitals('/runs', apply, io) };
}
it('attributes every owner class in a fake ps census for CPU and RSS without leaking paths', async () => {
  const f = fixture(), report = await f.read();
  for (const [owner, cpu] of [['orphan:RQ-DONE', 26], ['desktop:Editor', 28], ['guardian', 12], ['daemon', 13], ['unknown', 14], ['job:RQ-LIVE', 15]] as const) {
    for (const list of [report.topCpu, report.topMemory]) expect(list).toContainEqual(expect.objectContaining({ owner, cpuPercentOneCore: cpu, rssBytes: cpu * 10 * 1024 }));
  }
  expect(report.asOf).toBe(new Date(now).toISOString());
  expect(sanitizePublicJson(report.reaper.plan)).toBe(report.reaper.plan);
  expect(report.topCpu![0]!.owner).toBe('desktop:Editor');
  expect(report.reaper.candidates).toEqual([{ pid: 10, job: 'RQ-DONE' }]);
  expect(JSON.stringify(report)).not.toContain('/home'); expect(f.io.signal).not.toHaveBeenCalled();
  expect((await f.read(report.reaper.plan)).reaper.signalled).toEqual([10]); expect(f.io.signal).toHaveBeenCalledExactlyOnceWith(10);
});
it.each(['pid', 'boot', 'uid', 'gui', 'parent', 'executable', 'relaunch', 'malformed', 'missing', 'claim', 'recent'])('never reaps uncertain, GUI or non-fleet processes: %s', async fault => {
  const f = fixture();
  if (fault === 'pid') f.outputs.set('/bin/ps', f.outputs.get('/bin/ps')!.replace(date, 'Mon Nov 16 12:00:01 2026'));
  if (fault === 'boot') f.outputs.set('/usr/sbin/sysctl', null);
  if (fault === 'uid') f.io.uid = 502;
  if (fault === 'gui') f.outputs.set('/bin/ps', ps(10, 1, '/Applications/Editor.app/Contents/MacOS/node'));
  if (fault === 'parent') f.outputs.set('/bin/ps', ps(10, 20));
  if (fault === 'executable') f.outputs.set('/bin/ps', ps(10, 1, '/usr/bin/unrelated'));
  if (fault === 'relaunch') f.files.set('/runs/metrics/jobs.jsonl', f.files.get('/runs/metrics/jobs.jsonl') + '\n{"job":"RQ-DONE","event":"launch"}');
  if (fault === 'malformed') f.files.set('/runs/metrics/jobs.jsonl', '{');
  if (fault === 'missing') f.outputs.set('/usr/sbin/lsof', null);
  if (fault === 'claim') f.files.delete('/runs/queue/run/resource-sessions/RQ-DONE.json');
  if (fault === 'recent') f.io.now = () => now - 60_000;
  const preview = await f.read(); expect(preview.reaper.candidates).toEqual([]);
  await f.read(preview.reaper.plan); expect(f.io.signal).not.toHaveBeenCalled();
});
it('rejects a changed preview and rechecks identity immediately before SIGTERM', async () => {
  const f = fixture(); await expect(f.read('0'.repeat(64))).rejects.toThrow('plan changed');
  const preview = await f.read(), run = f.io.run; let samples = 0;
  f.io.run = async (file, args) => file === '/bin/ps' && ++samples > 1 ? ps(10, 1, '/Applications/Editor.app/Contents/MacOS/node') : run(file, args);
  expect((await f.read(preview.reaper.plan)).reaper.skipped).toEqual([10]); expect(f.io.signal).not.toHaveBeenCalled();
});
it('keeps failed or malformed censuses unknown and caps both rankings at ten', async () => {
  const f = fixture();
  for (const text of [null, '', 'bad ps', `${ps(10)}\n${ps(10)}`]) { f.outputs.set('/bin/ps', text); expect(await f.read()).toMatchObject({ state: 'unknown', topCpu: null, topMemory: null }); }
  f.outputs.set('/bin/ps', Array.from({ length: 15 }, (_, n) => ps(n + 10)).join('\n'));
  f.outputs.set('/usr/sbin/lsof', Array.from({ length: 15 }, (_, n) => `p${n + 10}\nn/home/Projects/ashlrai/wt/RQ-J${n}`).join('\n'));
  const r = await f.read(); expect(r.topCpu).toHaveLength(10); expect(r.topMemory).toHaveLength(10);
  f.outputs.set('/bin/ps', `${ps(15)}\n${ps(10).replace('10 100 ', '10 999 ')}`);
  const ranked = await f.read(); expect(ranked.topCpu![0]!.cpuPercentOneCore).toBe(15); expect(ranked.topMemory![0]!.cpuPercentOneCore).toBe(10);
  f.io.run = async () => { throw new Error('denied'); }; expect(await f.read()).toMatchObject({ state: 'unknown', topCpu: null, topMemory: null });
});
