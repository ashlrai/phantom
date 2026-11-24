import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';

export interface ProcessVitalsIo {
  home: string; uid: number; now(): number;
  run(file: string, args: string[]): Promise<string | null>;
  read(file: string): string | null;
  signal(pid: number): void;
}
type Owner = { owner: string; processes: number; cpuPercentOneCore: number; rssBytes: number };
type Row = { pid: number; ppid: number; uid: number; cpu: number; rss: number; start: string; executable: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set(['MERGED', 'CLOSED', 'DONE-NOOP']);
function host(root: string): ProcessVitalsIo {
  return { home: homedir(), uid: process.getuid?.() ?? -1, now: Date.now,
    run: (file, args) => new Promise(resolve => execFile(file, args, { timeout: 5000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } }, (error, stdout) => resolve(error ? null : stdout))),
    read: file => { const r = readStableRegularFile(file, { anchorPath: root, maxFileBytes: 16 * 1024 * 1024, remainingBytes: 16 * 1024 * 1024 }); return r.ok ? r.text : null; },
    signal: pid => { process.kill(pid, 'SIGTERM'); } };
}
/** No argv or environment inspection. A failed/incomplete census stays unknown. */
async function snapshot(root: string, io: ProcessVitalsIo) {
  const run = async (file: string, args: string[]) => { try { return await io.run(file, args); } catch { return null; } };
  const [ps, cwdText, services, boot] = await Promise.all([
    run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,uid=,pcpu=,rss=,lstart=,comm=']),
    run('/usr/sbin/lsof', ['-nP', '-a', '-d', 'cwd', '-Fpn']),
    run('/bin/launchctl', ['list']), run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']),
  ]);
  const rows = new Map<number, Row>(), cwds = new Map<number, string>(), service = new Map<number, string>();
  let pid = 0, valid = !!ps?.trim();
  for (const line of ps?.trim().split('\n') ?? []) {
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line.trim());
    if (!m || !Number.isFinite(Date.parse(m[6]!)) || rows.has(Number(m[1]))) { valid = false; break; }
    const [p, parent, uid, cpu, rss] = m.slice(1, 6).map(Number);
    if (![p, parent, uid, rss].every(n => Number.isSafeInteger(n) && n! >= 0) || !p || !Number.isFinite(cpu) || !Number.isSafeInteger(rss! * 1024)) { valid = false; break; }
    rows.set(p!, { pid: p!, ppid: parent!, uid: uid!, cpu: cpu!, rss: rss! * 1024, start: Math.floor(Date.parse(m[6]!) / 1000).toString(16).padStart(64, '0'), executable: m[7]! });
  }
  for (const line of cwdText?.split('\n') ?? []) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith('n/')) cwds.set(pid, line.slice(1));
  }
  for (const line of services?.split('\n') ?? []) {
    const m = /^(\d+)\s+\S+\s+ai\.ashlr\.(main-guardian|daemon)$/.exec(line.trim());
    if (m) service.set(Number(m[1]), m[2] === 'daemon' ? 'daemon' : 'guardian');
  }
  const outcomes = new Map<string, number>();
  let ledgerKnown = false;
  try {
    const ledger = io.read(join(root, 'metrics/jobs.jsonl'));
    if (ledger === null) throw new Error('missing');
    for (const line of ledger.split('\n').filter(s => s.trim())) {
      const r = JSON.parse(line) as Record<string, unknown>;
      const job = [r.job, r.job_id, r.jobId, r.id].find((v): v is string => typeof v === 'string') ?? null;
      const event = [r.event, r.type, r.kind].find((v): v is string => typeof v === 'string');
      const state = [r.state, r.outcome, r.status, r.phase, r.result, r.conclusion].find((v): v is string => typeof v === 'string');
      const stamp = [r.ts, r.timestamp, r.at, r.time, r.mergedAt, r.closedAt, r.recordedAt, r.updatedAt].find(v => v !== undefined && v !== null);
      const at = typeof stamp === 'number' ? stamp * 1000 : Date.parse(String(stamp ?? ''));
      if (job !== null) outcomes.delete(job);
      if (event === 'outcome' && state !== undefined && terminal.has(state) && Number.isFinite(at) && at <= io.now() && job !== null) outcomes.set(job, at);
    }
    ledgerKnown = true;
  } catch { outcomes.clear(); }
  const job = (p: number) => {
    const path = relative(join(io.home, 'Projects/ashlrai/wt'), cwds.get(p) ?? '/');
    return /^(RQ-[A-Za-z0-9_-]{1,76})(?:\/|$)/.exec(path)?.[1];
  };
  const owner = (row: Row): string => {
    let current: Row | undefined = row, inherited: string | undefined;
    const seen = new Set<number>();
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      const app = /\/([^/]+)\.app\/Contents\//.exec(current.executable);
      if (app) return `desktop:${app[1]!.replace(/[^\w .-]/g, '').slice(0, 64)}`;
      inherited ??= service.get(current.pid);
      current = rows.get(current.ppid);
    }
    const id = job(row.pid);
    return service.get(row.pid) ?? (id ? `${outcomes.has(id) ? 'orphan' : 'job'}:${id}` : inherited ?? 'unknown');
  };
  const groups = new Map<string, Owner>(), candidates: Array<{ pid: number; job: string; identity: string }> = [];
  if (valid) for (const row of rows.values()) {
    const name = owner(row), group = groups.get(name) ?? { owner: name, processes: 0, cpuPercentOneCore: 0, rssBytes: 0 };
    group.processes++; group.cpuPercentOneCore += row.cpu; group.rssBytes += row.rss; groups.set(name, group);
    if (!services || !name.startsWith('orphan:') || row.ppid !== 1 || row.uid !== io.uid || row.pid === process.pid ||
      !['node', 'codex', 'claude', 'bash', 'sh', 'zsh', 'python3'].includes(basename(row.executable))) continue;
    const id = job(row.pid)!;
    try {
      const claim = JSON.parse(io.read(join(root, 'queue/run/resource-sessions', `${id}.json`)) ?? 'null');
      const bootId = boot?.trim().toLowerCase();
      if (!bootId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId) || claim?.schemaVersion !== 1 ||
        claim.jobId !== id || claim.rootPid !== row.pid || claim.startSource !== 'ps-lstart' || claim.start !== row.start || claim.bootId !== bootId ||
        !/^[a-f0-9]{64}$/.test(claim.ownerWitness) || outcomes.get(id)! < parseInt(row.start, 16) * 1000 || io.now() - outcomes.get(id)! < 60_000) continue;
      candidates.push({ pid: row.pid, job: id, identity: hash([row.pid, row.ppid, row.uid, row.start, row.executable, cwds.get(row.pid), claim, outcomes.get(id)]) });
    } catch { /* Unproven roots are observational only. */ }
  }
  candidates.sort((a, b) => a.pid - b.pid);
  const top = (key: 'cpuPercentOneCore' | 'rssBytes') => valid ? [...groups.values()].sort((a, b) => b[key] - a[key] || a.owner.localeCompare(b.owner)).slice(0, 10) : null;
  return { asOf: new Date(io.now()).toISOString(), state: !valid ? 'unknown' : !cwdText || !services || !ledgerKnown || groups.has('unknown') ? 'partial' : 'known',
    cpuBasis: 'ps-average-one-core-100-percent', sharedRssMayBeCountedMultipleTimes: true, perProcessSwapBytes: null,
    topCpu: top('cpuPercentOneCore'), topMemory: top('rssBytes'), candidates: candidates.slice(0, 10) };
}
/** Apply requires the preview digest and fresh evidence for each individual root; never signal groups. */
export async function readProcessVitals(root: string, apply?: string, io = host(root)) {
  const { candidates, ...report } = await snapshot(root, io), plan = `sha256:${hash(candidates)}`;
  const signalled: number[] = [], skipped: number[] = [];
  if (apply !== undefined) {
    if (apply !== plan) throw new Error('Orphan plan changed; preview fleet vitals again.');
    for (const candidate of candidates) {
      const fresh = await snapshot(root, io);
      if (!fresh.candidates.some(c => c.identity === candidate.identity)) { skipped.push(candidate.pid); continue; }
      try { io.signal(candidate.pid); signalled.push(candidate.pid); } catch { skipped.push(candidate.pid); }
    }
  }
  return { ...report, reaper: { plan, candidates: candidates.map(({ pid, job }) => ({ pid, job })), signalled, skipped } };
}
