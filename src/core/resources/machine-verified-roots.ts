/** Local observational bindings only. These records never authorize a launch. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, opendirSync, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { listLiveWorkers, parsePsTable, parseEtime, type LiveWorker } from '../fleet/runs-live-workers.js';
import { verifiedProcessStartIdentity } from '../fleet/local-store-lock.js';
import { readStableRegularFile } from '../util/stable-file-read.js';

export interface VerifiedFleetRoot { jobId: string; pid: number; startRef: string; startRefSource: 'ps-lstart'|'linux-proc-start-ticks'|'windows-start-ticks'; bootRef: string; ownerBindingDigest: string }
export interface VerifiedFleetRootsObservation { schemaVersion: 1; scope: 'verified-fleet-process-roots'; authority: 'observation-only'; state: 'known'|'unknown'; observedAt: string; roots: VerifiedFleetRoot[] }
export interface MachineRootOptions { runsDir: string; worktreeRoot: string; now?: () => number }
export interface ProtectedAttemptWitness { schemaVersion: 1; source: 'protected-dispatch-records'; jobId: string; repo: string; lane: string; tier: string; worktreePath: string; worktreeIdentity: { dev: string; ino: string }; ownerBindingDigest: string }
export interface MachineRootDependencies {
  inspectTargetedWorkers(signal?: AbortSignal): Promise<unknown>;
  readProtectedAttempt(jobId: string, signal?: AbortSignal): Promise<ProtectedAttemptWitness | undefined>;
  readStart(pid: number, signal?: AbortSignal): Promise<{ source: VerifiedFleetRoot['startRefSource']; ref: string } | undefined>;
  readBoot(signal?: AbortSignal): Promise<string | null>;
  readUid(pid: number, signal?: AbortSignal): Promise<number | null>;
  uid: number; now(): number;
}
/** Local OS ports for deterministic default-factory tests; never provider/authority callbacks. */
export interface MachineRootIo {
  platform: NodeJS.Platform; uid: number;
  command(file: string, args: string[], signal?: AbortSignal): Promise<string>;
  readKernelFile(file: string, signal?: AbortSignal): Promise<string | null>;
}
const MAX_ROOTS = 128, MAX_CANDIDATES = 512, MAX_NAMESPACE_ENTRIES = 65536, DEADLINE_MS = 5000, MAX_AGE_MS = 30000;
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 80 && v !== '.' && v !== '..' && !/[^A-Za-z0-9._-]/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]+$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const pid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const names = new Set(['bash','sh','zsh','node','bun','Python','python','python3','codex','devin','claude','git']);
const stopped = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('observation cancelled'); };
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const stamp = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.mode}:${s.uid}:${s.gid}:${s.nlink}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function contained(root: string, path: string): boolean { const r = relative(root, path); return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); }
function directory(path: string): BigIntStats {
  const s = lstatSync(path, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(process.getuid?.() ?? -1) || (s.mode & 0o022n) !== 0n || realpathSync(path) !== path) throw new Error('unsafe directory');
  return s;
}
function parents(anchor: string, path: string): string[] {
  if (!contained(anchor, path)) throw new Error('outside anchor');
  const dirs = [anchor]; let current = anchor;
  for (const name of relative(anchor, dirname(path)).split(sep).filter(Boolean)) { current = join(current, name); dirs.push(current); }
  return dirs;
}
function regular(path: string): BigIntStats {
  const s = lstatSync(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || s.uid !== BigInt(process.getuid?.() ?? -1) || (s.mode & 0o022n) !== 0n || realpathSync(path) !== path) throw new Error('unsafe file');
  return s;
}
function protectedRead(root: string, path: string, max = 16384) {
  const dirs = parents(root, path).map(p => ({ path: p, stamp: stamp(directory(p)) }));
  const before = regular(path), result = readStableRegularFile(path, { anchorPath: root, maxFileBytes: max, remainingBytes: max });
  if (!result.ok || stamp(before) !== stamp(regular(path)) || dirs.some(d => stamp(directory(d.path)) !== d.stamp)) throw new Error('changed witness');
  return { text: result.text, identity: stamp(before), dirs };
}
/** Reads only launcher metadata. Prompt contents are never opened. */
export function readProtectedAttemptWitness(options: MachineRootOptions, jobId: string): ProtectedAttemptWitness | undefined {
  try {
    if (!id(jobId)) return undefined;
    const root = resolve(options.runsDir), wtRoot = resolve(options.worktreeRoot), run = join(root, 'queue', 'run');
    for (const p of [root, join(root, 'queue'), run, wtRoot]) directory(p);
    const line = protectedRead(root, join(run, `${jobId}.line`)), base = protectedRead(root, join(root, `${jobId}.base`));
    const dispatched = protectedRead(root, join(run, `${jobId}.dispatched`));
    const parts = line.text.replace(/\r?\n$/, '').split('\t'), b = base.text.trim().split(/\s+/);
    if ((parts.length !== 5 && !(parts.length === 6 && parts[5] === 'pin')) || parts[0] !== jobId ||
      !/^[a-z0-9._-]{1,64}$/.test(parts[1] ?? '') || !/^[a-z0-9-]{1,32}$/.test(parts[2] ?? '') ||
      !['frontier','work','mid','fast','low'].includes(parts[3] ?? '') || line.text.includes('\n', 0) && !/^\S[^\r\n]*\r?\n?$/.test(line.text) ||
      b.length !== 4 || !/^[a-f0-9]{40}$/.test(b[0] ?? '') || b[1] !== `codex-bridge/${jobId}` || b[3] !== parts[2] || !/^\d{1,12}\n?$/.test(dispatched.text)) return undefined;
    const prompt = parts[4]!, promptRoot = join(root, 'queue', 'prompts');
    if (!isAbsolute(prompt) || resolve(prompt) !== prompt || !contained(promptRoot, prompt)) return undefined;
    const promptDirs = parents(root, prompt).map(p => ({ path: p, stamp: stamp(directory(p)) }));
    const promptStamp = stamp(regular(prompt));
    const worktreePath = b[2]!;
    if (!contained(wtRoot, worktreePath) || worktreePath !== join(wtRoot, jobId)) return undefined;
    const worktree = directory(worktreePath);
    const metadata: unknown[] = [line, base, dispatched, { promptStamp, promptDirs }];
    const ownerDirectory = join(run, `${jobId}.root-owner`), ownerPath = join(ownerDirectory, 'owner.json');
    let ownerPresent = true;
    try { lstatSync(ownerDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') ownerPresent = false; else throw error; }
    if (ownerPresent) {
      directory(ownerDirectory);
      const owner = protectedRead(root, ownerPath), parsed: unknown = JSON.parse(owner.text);
      if (!object(parsed) || typeof parsed.owner !== 'string' || !/^[/A-Za-z0-9._-]{1,160}$/.test(parsed.owner) ||
          parsed.job !== undefined && parsed.job !== jobId || parsed.durable !== undefined && typeof parsed.durable !== 'boolean') return undefined;
      metadata.push(owner);
    }
    if (stamp(regular(prompt)) !== promptStamp || promptDirs.some(d => stamp(directory(d.path)) !== d.stamp)) return undefined;
    const again = [protectedRead(root, join(run, `${jobId}.line`)), protectedRead(root, join(root, `${jobId}.base`)), protectedRead(root, join(run, `${jobId}.dispatched`))];
    if (!same(metadata.slice(0, 3), again) || stamp(directory(worktreePath)) !== stamp(worktree)) return undefined;
    return { schemaVersion: 1, source: 'protected-dispatch-records', jobId, repo: parts[1]!, lane: parts[2]!, tier: parts[3]!, worktreePath,
      worktreeIdentity: { dev: String(worktree.dev), ino: String(worktree.ino) }, ownerBindingDigest: digest(JSON.stringify(metadata) + stamp(worktree)) };
  } catch { return undefined; }
}
async function kernelFile(file: string, signal?: AbortSignal): Promise<string | null> {
  let handle;
  try {
    stopped(signal); handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const bytes = Buffer.alloc(65537); let offset = 0;
    while (offset < bytes.length) { stopped(signal); const r = await handle.read(bytes, offset, bytes.length - offset, offset); if (!r.bytesRead) break; offset += r.bytesRead; }
    return offset > 65536 ? null : bytes.subarray(0, offset).toString('utf8');
  } catch { return null; } finally { await handle?.close(); }
}
const realIo: MachineRootIo = {
  platform: process.platform, uid: process.getuid?.() ?? -1, readKernelFile: kernelFile,
  command: (file, args, signal) => new Promise((resolveCommand, reject) => {
    stopped(signal);
    execFile(file, args, { signal, timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' } }, (error, stdout) => {
        // ps may return 1 when selected processes exit. Only this targeted
        // ownership read can reconcile that with another complete numeric census.
        const departed = error?.code === 1 && file === '/bin/ps' && args.includes('pid=,etime=,command=');
        if (error && !departed) reject(new Error('OS observation unavailable')); else resolveCommand(stdout);
      });
  }),
};
function uuid(text: string): string | null { const v = text.trim().toLowerCase(); return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v) ? v : null; }
/** Reuse the established source-tagged parser on an already bounded OS observation.
 * This is observational ps-lstart (second resolution), never a native launch witness. */
export function observedPsStartIdentity(p: number, text: string, platform: NodeJS.Platform) {
  const value = verifiedProcessStartIdentity(p, { requiredSource: 'ps-lstart', runtime: { platform,
    run: () => ({ status: 0, stdout: text }), readLinuxProcStat: () => undefined } });
  return value && value.source !== 'self-clock-epoch-second' ? { source: value.source, ref: value.ref } : undefined;
}
function ownershipCensus(text: string) {
  const rows = new Map<number, { ppid: number; uid: number; name: string }>();
  for (const line of text.trim().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m || !pid(Number(m[1])) || !Number.isSafeInteger(Number(m[2])) || !Number.isSafeInteger(Number(m[3])) || rows.has(Number(m[1]))) throw new Error('invalid census');
    rows.set(Number(m[1]), { ppid: Number(m[2]), uid: Number(m[3]), name: basename(m[4]!) });
    if (rows.size > 16384) throw new Error('census budget');
  }
  if (!rows.size) throw new Error('incomplete census');
  return rows;
}
/** Concrete production defaults; low-level injected IO exercises this same factory. */
export function createMachineRootDependencies(options: MachineRootOptions, io: MachineRootIo = realIo): MachineRootDependencies {
  const command = async (args: string[], signal?: AbortSignal) => { stopped(signal); const value = await io.command('/bin/ps', args, signal); stopped(signal); return value; };
  return {
    uid: io.uid, now: options.now ?? Date.now,
    inspectTargetedWorkers: signal => listLiveWorkers({ now: options.now, runPs: async () => {
      const rows = ownershipCensus(await command(['-axo', 'pid=,ppid=,uid=,comm='], signal));
      const targets = [...rows].filter(([, r]) => r.uid === io.uid && names.has(r.name)).map(([p]) => p);
      if (targets.length > MAX_CANDIDATES) throw new Error('inspection budget');
      if (!targets.length) return '';
      const text = await command(['-ww', '-p', targets.join(','), '-o', 'pid=,etime=,command='], signal);
      const seen = new Set<number>(), byJob = new Map<string, number[]>();
      for (const line of text.trim() ? text.trim().split('\n') : []) {
        const m = /^\s*(\d+)\s+(\S+)\s+\S/.exec(line), p = Number(m?.[1]);
        if (!m || parseEtime(m[2]!) === null || !targets.includes(p) || seen.has(p)) throw new Error('invalid inspection');
        seen.add(p);
        for (const worker of parsePsTable(line).workers) {
          const argv = /^\s*\d+\s+\S+\s+(.+)$/.exec(line)?.[1] ?? '';
          const launcher = join(resolve(options.runsDir), 'bin', 'launch.sh');
          if (![`/bin/bash ${launcher} `, `bash ${launcher} `, `${launcher} `].some(prefix => argv.startsWith(prefix))) throw new Error('unbound launcher path');
          byJob.set(worker.job, [...byJob.get(worker.job) ?? [], p]);
        }
      }
      const missing = targets.filter(p => !seen.has(p));
      if (missing.length) {
        const after = ownershipCensus(await command(['-axo', 'pid=,ppid=,uid=,comm='], signal));
        if (missing.some(p => after.has(p)) || [...after].some(([p, row]) => row.uid === io.uid && names.has(row.name) && !targets.includes(p))) throw new Error('incomplete inspection');
      }
      // Repeated launch argv from a subshell belongs to the same root only when
      // its current numeric PPID chain proves that relationship. Siblings refuse.
      for (const group of byJob.values()) {
        const root = Math.min(...group);
        for (let child of group) { const walked = new Set<number>(); while (child !== root && !walked.has(child) && rows.has(child)) { walked.add(child); child = rows.get(child)!.ppid; } if (child !== root) throw new Error('duplicate root'); }
      }
      const roots = new Set([...byJob.values()].map(group => Math.min(...group)));
      for (const root of roots) {
        let parent = rows.get(root)?.ppid; const seen = new Set<number>();
        while (parent !== undefined && parent > 0 && !seen.has(parent)) {
          if (roots.has(parent)) throw new Error('nested job roots');
          seen.add(parent); parent = rows.get(parent)?.ppid;
        }
      }
      return text;
    } }),
    readProtectedAttempt: async (job, signal) => { stopped(signal); return readProtectedAttemptWitness(options, job); },
    readStart: async (p, signal) => {
      const text = await command(['-o', 'lstart=', '-p', String(p)], signal);
      return observedPsStartIdentity(p, text, io.platform);
    },
    readBoot: async signal => {
      stopped(signal);
      if (io.platform === 'linux') { const value = await io.readKernelFile('/proc/sys/kernel/random/boot_id', signal); stopped(signal); const boot = value === null ? null : uuid(value); return boot ? digest(`machine-observation-linux-boot-v1\0${boot}`) : null; }
      if (io.platform !== 'darwin') return null;
      const before = uuid(await io.command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], signal));
      if (!before) return null;
      const platform = await io.command('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], signal);
      const matches = [...platform.matchAll(/"IOPlatformUUID"\s*=\s*"([^"\r\n]+)"/g)], machine = matches.length === 1 ? uuid(matches[0]![1]!) : null;
      const after = uuid(await io.command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], signal)); stopped(signal);
      return machine && after === before ? digest(JSON.stringify({ machineDigest: digest(`ashlr-native-machine-v1\0${machine}`), bootId: before })) : null;
    },
    readUid: async (p, signal) => { const text = (await command(['-p', String(p), '-o', 'uid='], signal)).trim(); return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null; },
  };
}
function coverage(options: MachineRootOptions, now: number, deadline: number, signal: AbortSignal) {
  const root = resolve(options.runsDir), run = join(root, 'queue', 'run');
  const status = protectedRead(root, join(root, 'queue', 'status.json'), 1024 * 1024), value: unknown = JSON.parse(status.text);
  if (!object(value) || value.schema !== 'dispatchd.status.v1' || typeof value.last_tick !== 'string' || !Number.isFinite(Date.parse(value.last_tick)) || now - Date.parse(value.last_tick) < 0 || now - Date.parse(value.last_tick) > MAX_AGE_MS || !object(value.lanes)) throw new Error('unknown coverage');
  const counts = Object.values(value.lanes).map(row => object(row) ? row.running : null);
  if (counts.some(v => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)) throw new Error('unknown coverage');
  const dirs = [root, join(root, 'queue'), run, resolve(options.worktreeRoot)].map(p => ({ path: p, identity: stamp(directory(p)) }));
  // The run directory retains historical receipts. Enumerate it completely,
  // but retain only dispatch markers, under the existing observation deadline.
  const pending: string[] = [], handle = opendirSync(run); let enumerated = 0;
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      stopped(signal);
      if (++enumerated > MAX_NAMESPACE_ENTRIES || performance.now() >= deadline) throw new Error('namespace budget');
      if (!entry.name.endsWith('.dispatched')) continue;
      if (!id(entry.name.slice(0, -11))) throw new Error('invalid pending job');
      pending.push(entry.name);
      if (pending.length > MAX_ROOTS) throw new Error('root budget');
    }
  } finally { handle.closeSync(); }
  pending.sort();
  const records = pending.map(name => { const job = name.slice(0, -11); if (!id(job)) throw new Error('invalid pending job'); const record = protectedRead(root, join(run, name)), witness = readProtectedAttemptWitness(options, job); if (!witness) throw new Error('unverified pending owner'); return { job, ...record, witness }; });
  if (dirs.some(d => stamp(directory(d.path)) !== d.identity)) throw new Error('coverage changed');
  return { count: counts.reduce<number>((sum, v) => sum + Number(v), 0), status, dirs, records };
}
function workers(value: unknown, now: number): LiveWorker[] {
  if (!object(value) || value.v !== 1 || value.sourceState !== 'healthy' || !Array.isArray(value.workers) || value.workers.length > MAX_ROOTS || !Array.isArray(value.leaders) || !Number.isSafeInteger(value.orchestratorAgents) || Number(value.orchestratorAgents) < 0 || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)) || now - Date.parse(value.generatedAt) < 0 || now - Date.parse(value.generatedAt) > MAX_AGE_MS) throw new Error('invalid snapshot');
  const seenPid = new Set<number>(), seenJob = new Set<string>();
  for (const w of value.workers) {
    if (!object(w) || !id(w.job) || !pid(w.pid) || typeof w.repo !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(w.repo) || typeof w.lane !== 'string' || !/^[a-z0-9-]{1,32}$/.test(w.lane) || typeof w.tier !== 'string' || !['frontier','work','mid','fast','low'].includes(w.tier) || seenPid.has(w.pid) || seenJob.has(w.job)) throw new Error('invalid worker');
    seenPid.add(w.pid); seenJob.add(w.job);
  }
  return value.workers as LiveWorker[];
}
const stableWorkers = (rows: LiveWorker[]) => rows.map(({ pid, job, repo, lane, tier }) => ({ pid, job, repo, lane, tier })).sort((a, b) => a.pid - b.pid);
/** One five-second budget cancels owned OS probes and bounds even a hung async dependency. */
export async function readVerifiedFleetRoots(options: MachineRootOptions, dependencies?: MachineRootDependencies): Promise<VerifiedFleetRootsObservation> {
  const d = dependencies ?? createMachineRootDependencies(options), now = d.now();
  const frame: VerifiedFleetRootsObservation = { schemaVersion: 1, scope: 'verified-fleet-process-roots', authority: 'observation-only', state: 'unknown', observedAt: new Date(Number.isFinite(now) && Math.abs(now) <= 8.64e15 ? now : 0).toISOString(), roots: [] };
  const controller = new AbortController(), deadline = performance.now() + DEADLINE_MS; let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = new Promise<VerifiedFleetRootsObservation>(resolveDeadline => { timer = setTimeout(() => { controller.abort(); resolveDeadline(frame); }, DEADLINE_MS); });
  const signal = controller.signal;
  const observe = async (): Promise<VerifiedFleetRootsObservation> => {
    try {
      if (!Number.isSafeInteger(d.uid) || d.uid < 0 || !Number.isFinite(now)) return frame;
      const boot = await d.readBoot(signal); stopped(signal); if (!hash(boot)) return frame;
      const before = coverage(options, d.now(), deadline, signal), first = workers(await d.inspectTargetedWorkers(signal), d.now()); stopped(signal);
      if (before.count !== first.length || before.records.length !== first.length || before.records.some(r => !first.some(w => w.job === r.job))) return frame;
      const roots: VerifiedFleetRoot[] = [], witnesses: unknown[] = [];
      for (const w of first) {
        stopped(signal);
        const owner = await d.readProtectedAttempt(w.job, signal), start = await d.readStart(w.pid, signal), uid = await d.readUid(w.pid, signal); stopped(signal);
        if (!owner || owner.schemaVersion !== 1 || owner.source !== 'protected-dispatch-records' || owner.jobId !== w.job || owner.repo !== w.repo || owner.lane !== w.lane || owner.tier !== w.tier || !hash(owner.ownerBindingDigest) || !same(owner, before.records.find(r => r.job === w.job)?.witness) || !start || !hash(start.ref) || !['ps-lstart','linux-proc-start-ticks','windows-start-ticks'].includes(start.source) || uid !== d.uid) return frame;
        witnesses.push({ owner, start, uid });
        roots.push({ jobId: w.job, pid: w.pid, startRef: start.ref, startRefSource: start.source, bootRef: boot, ownerBindingDigest: owner.ownerBindingDigest });
      }
      const after = workers(await d.inspectTargetedWorkers(signal), d.now()); stopped(signal);
      if (!same(stableWorkers(first), stableWorkers(after))) return frame;
      for (let i = 0; i < first.length; i++) {
        const w = first[i]!; const owner = await d.readProtectedAttempt(w.job, signal), start = await d.readStart(w.pid, signal), uid = await d.readUid(w.pid, signal); stopped(signal);
        if (!same(witnesses[i], { owner, start, uid })) return frame;
      }
      if (await d.readBoot(signal) !== boot) return frame;
      stopped(signal); if (!same(before, coverage(options, d.now(), deadline, signal))) return frame;
      stopped(signal); return { ...frame, state: 'known', roots };
    } catch { return frame; }
  };
  try { return await Promise.race([observe(), expire]); } finally { clearTimeout(timer); controller.abort(); }
}
