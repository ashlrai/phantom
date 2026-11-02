import { readFile, writeFile, rename, mkdir, rm, stat, realpath } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Config, Job, Verdict, configFrom, queueFrom, hash, object, keys, ID, SHA, green, screen } from './policy.js';
import { dispatch, freshReview, isolatedRun } from './process.js';
import { GitHub, Snapshot, Pull } from './github.js';

type Stage = 'queued' | 'dispatching' | 'review' | 'reserved' | 'enabled' | 'cancelled' | 'merged' | 'done' | 'exception';
interface Entry { repo: string; digest: string; stage: Stage; attempts: number; pr: number | null; url: string | null; sha: string | null; mergeSha: string | null; verdict: 'approve' | 'reject' | null }
interface Reservation { repo: string; pr: number; sha: string; at: number; settled: boolean }
export interface State { version: 1; jobs: Record<string, Entry>; queue: Record<string, string>; reservations: Reservation[]; reverted: string[]; acknowledged: string[]; halt: string | null }
export const initial = (): State => ({ version: 1, jobs: {}, queue: {}, reservations: [], reverted: [], acknowledged: [], halt: null });
const stages: Stage[] = ['queued', 'dispatching', 'review', 'reserved', 'enabled', 'cancelled', 'merged', 'done', 'exception'];
export function stateFrom(raw: string, c: Config): State {
  const s = object(JSON.parse(raw)); keys(s, ['version', 'jobs', 'queue', 'reservations', 'reverted', 'acknowledged', 'halt']);
  if (s.version !== 1 || (s.halt !== null && !['two-reverts', 'main-red', 'unknown-outcome', 'state-integrity'].includes(String(s.halt)))) throw new Error('invalid-state');
  for (const [id, rawEntry] of Object.entries(object(s.jobs))) {
    const e = object(rawEntry); keys(e, ['repo', 'digest', 'stage', 'attempts', 'pr', 'url', 'sha', 'mergeSha', 'verdict']);
    if (!ID.test(id) || !c.repos.includes(String(e.repo)) || !/^[a-f0-9]{64}$/.test(String(e.digest)) ||
        !stages.includes(e.stage as Stage) || !Number.isInteger(e.attempts) || Number(e.attempts) < 0 || Number(e.attempts) > 2 ||
        (e.pr !== null && (!Number.isSafeInteger(e.pr) || Number(e.pr) < 1)) ||
        [e.sha, e.mergeSha].some(v => v !== null && !SHA.test(String(v))) || ![null, 'approve', 'reject'].includes(e.verdict as null)) throw new Error('invalid-state');
    if (['review', 'reserved', 'enabled', 'cancelled', 'merged', 'done'].includes(String(e.stage)) && e.pr === null) throw new Error('invalid-state');
    if (['reserved', 'enabled', 'cancelled', 'merged', 'done'].includes(String(e.stage)) && e.sha === null) throw new Error('invalid-state');
    if (e.url !== (e.pr === null ? null : `https://github.com/${e.repo}/pull/${e.pr}`)) throw new Error('invalid-state');
  }
  for (const [id, digest] of Object.entries(object(s.queue))) if (!ID.test(id) || !/^[a-f0-9]{64}$/.test(String(digest))) throw new Error('invalid-state');
  if (!Array.isArray(s.reservations) || s.reservations.length > 100000) throw new Error('invalid-state');
  for (const rawReservation of s.reservations) {
    const r = object(rawReservation); keys(r, ['repo', 'pr', 'sha', 'at', 'settled']);
    if (!c.repos.includes(String(r.repo)) || !Number.isSafeInteger(r.pr) || Number(r.pr) < 1 || !SHA.test(String(r.sha)) || !Number.isSafeInteger(r.at) || Number(r.at) < 0 || typeof r.settled !== 'boolean') throw new Error('invalid-state');
  }
  for (const list of [s.reverted, s.acknowledged]) if (!Array.isArray(list) || !list.every(v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v))) throw new Error('invalid-state');
  return s as unknown as State;
}
export function withinCap(s: State, repo: string, now: number, cap: number): boolean {
  // Reservations count even when a process crashes or GitHub's response is lost.
  return s.reservations.filter(r => r.repo === repo && (!r.settled || r.at > now - 3600000)).length < 3 &&
    s.reservations.filter(r => !r.settled || r.at > now - 86400000).length < cap && !s.reservations.some(r => r.at > now);
}
export interface Ports {
  github: Pick<GitHub, 'pull' | 'snapshot' | 'checks' | 'main' | 'reverted' | 'cancel' | 'approve' | 'enable'>;
  review(config: Config, diff: string, rules: string): Promise<Verdict>;
  dispatch(job: Job, repair: number | null): Promise<{ pr?: number; failed?: boolean }>;
  paused(): Promise<boolean>; authorized(): Promise<boolean>;
  save(s: State): Promise<void>; audit(event: Record<string, unknown>): Promise<void>;
  now(): number;
  wake(event: Record<string, unknown>): Promise<void>;
}
export class Supervisor {
  constructor(readonly config: Config, readonly rules: string, readonly state: State, readonly ports: Ports) {}
  private async event(type: string, fields: Record<string, unknown> = {}): Promise<void> {
    const event = { type, at: this.ports.now(), ...fields,
      ...(typeof fields.repo === 'string' && Number.isSafeInteger(fields.pr) ? { url: `https://github.com/${fields.repo}/pull/${fields.pr}` } : {}) };
    await this.ports.audit(event);
    if (type === 'box-exception') await this.ports.wake(event);
  }
  private async exception(id: string, reason: string): Promise<void> {
    const entry = this.state.jobs[id];
    if (entry.stage === 'cancelled') entry.verdict = 'reject';
    else entry.stage = 'exception';
    await this.ports.save(this.state);
    // The box watches these records. Never wake it with raw task/diff/model text.
    await this.event('box-exception', { id, reason });
  }
  private async cancel(id: string, entry: Entry): Promise<void> {
    if (entry.pr !== null) await this.ports.github.cancel(entry.repo, entry.pr);
    for (const r of this.state.reservations) if (r.repo === entry.repo && r.pr === entry.pr && !r.settled) { r.settled = true; r.at = this.ports.now(); }
    entry.stage = 'cancelled'; entry.verdict = null;
    await this.ports.save(this.state); await this.event('auto-disabled', { id });
  }
  async tick(jobs: Job[], queueRead = true, queueValid = true): Promise<void> {
    // Stop cancellation precedes every fallible GitHub read or queue operation.
    const stopped = !queueValid || this.state.halt || await this.ports.paused() || !(await this.ports.authorized());
    if (stopped) {
      for (const [id, e] of Object.entries(this.state.jobs)) if (['enabled', 'reserved'].includes(e.stage)) await this.cancel(id, e);
      if (this.state.halt) await this.event('box-exception', { reason: this.state.halt });
    }
    const next = Object.fromEntries(jobs.map(j => [j.id, hash(JSON.stringify(j))]));
    const changes = [...new Set([...Object.keys(this.state.queue), ...Object.keys(next)])].map(id => ({ id,
      change: !(id in next) ? 'removed' : !(id in this.state.queue) ? 'added' : next[id] === this.state.queue[id] ? 'unchanged' : 'changed',
      before: this.state.queue[id] ?? null, after: next[id] ?? null }));
    if (queueRead) {
      await this.event('queue-read', { changes }); this.state.queue = next;
      await this.ports.save(this.state);
    }
    if (stopped) return;
    // Recover ambiguous effects before dispatching anything. A crash is never a retry signal.
    for (const [id, entry] of Object.entries(this.state.jobs)) {
      if (entry.stage === 'dispatching' || entry.stage === 'reserved') {
        this.state.halt = 'unknown-outcome';
        if (entry.stage === 'reserved') await this.cancel(id, entry);
        await this.exception(id, 'unknown-outcome');
      }
      if (entry.stage === 'enabled' || entry.stage === 'cancelled') {
        const p: Pull = await this.ports.github.pull(entry.repo, entry.pr!);
        if (p.merged) {
          if (!p.merge_commit_sha || !SHA.test(p.merge_commit_sha)) throw new Error('unknown-merge');
          entry.mergeSha = p.merge_commit_sha; entry.stage = 'merged';
          const mergedAt = Date.parse(p.merged_at ?? '');
          if (!Number.isSafeInteger(mergedAt) || mergedAt > this.ports.now()) throw new Error('unknown-merge-time');
          for (const r of this.state.reservations) if (r.repo === entry.repo && r.pr === entry.pr && r.sha === entry.sha) { r.at = mergedAt; r.settled = true; }
          if (p.head.sha !== entry.sha) {
            this.state.halt = 'state-integrity';
            await this.event('box-exception', { id, reason: 'merged-unreviewed-head', sha: p.head.sha });
          }
          await this.event('merge-observed', { id, pr: entry.pr, sha: entry.sha, mergeSha: entry.mergeSha });
        } else if (entry.stage === 'cancelled') {
          entry.stage = entry.verdict === 'reject' ? 'exception' : 'review';
          if (next[id] !== entry.digest || p.state !== 'open') await this.exception(id, 'queue-or-pr-changed');
        } else if (await this.ports.paused() || this.state.halt || !(await this.ports.authorized()) ||
                   p.head.sha !== entry.sha || p.state !== 'open' || next[id] !== entry.digest) {
          await this.cancel(id, entry);
          if (next[id] !== entry.digest || p.state !== 'open') await this.exception(id, 'queue-or-pr-changed');
        }
      }
      if (entry.mergeSha) {
        if (await this.ports.github.reverted(entry.repo, entry.mergeSha) && !this.state.reverted.includes(entry.mergeSha) && !this.state.acknowledged.includes(entry.mergeSha)) {
          this.state.reverted.push(entry.mergeSha); await this.event('revert-observed', { id, sha: entry.mergeSha });
        }
        const main = await this.ports.github.main(entry.repo);
        await this.event('main-checks', { repo: entry.repo, sha: main.sha, checks: main.checks });
        if (main.checks.some(c => ['failure', 'error', 'cancelled', 'timed_out', 'action_required'].includes(c.state))) this.state.halt = 'main-red';
        if (green(main.checks, this.config.requiredChecks[entry.repo])) entry.stage = 'done';
      }
    }
    if (this.state.reverted.length >= 2) this.state.halt = 'two-reverts';
    await this.ports.save(this.state);
    if (this.state.halt || await this.ports.paused() || !(await this.ports.authorized())) {
      for (const [id, entry] of Object.entries(this.state.jobs)) if (entry.stage === 'enabled') await this.cancel(id, entry);
      if (this.state.halt) await this.event('box-exception', { reason: this.state.halt });
      return;
    }
    // One outstanding auto-merge globally: observe its actual merge and main CI
    // before admitting the next. launchd invocations also hold a filesystem lock.
    if (Object.values(this.state.jobs).some(e => ['enabled', 'cancelled', 'merged'].includes(e.stage))) return;
    for (const job of jobs) {
      let entry = Object.hasOwn(this.state.jobs, job.id) ? this.state.jobs[job.id] : undefined;
      if (entry && entry.digest !== next[job.id]) { await this.exception(job.id, 'queue-changed'); continue; }
      if (!entry) entry = this.state.jobs[job.id] = { repo: job.repo, digest: next[job.id], stage: 'queued', attempts: 0, pr: null, url: null, sha: null, mergeSha: null, verdict: null };
      if (['done', 'exception'].includes(entry.stage)) continue;
      if (await this.ports.paused()) return;
      if (entry.stage === 'queued') {
        if (entry.attempts >= 2) { await this.exception(job.id, 'retry-exhausted'); continue; }
        entry.stage = 'dispatching'; entry.attempts++;
        await this.ports.save(this.state);
        let result: { pr?: number; failed?: boolean };
        try { result = await this.ports.dispatch(job, entry.pr); }
        catch { this.state.halt = 'unknown-outcome'; await this.exception(job.id, 'dispatch-unknown'); return; }
        if (result.failed) { entry.stage = 'queued'; await this.ports.save(this.state); return; }
        if (!Number.isSafeInteger(result.pr) || Number(result.pr) < 1) throw new Error('invalid-dispatch');
        if (entry.pr !== null && result.pr !== entry.pr) { await this.exception(job.id, 'repair-pr-changed'); return; }
        entry.pr = result.pr!; entry.url = `https://github.com/${job.repo}/pull/${entry.pr}`; entry.stage = 'review'; await this.ports.save(this.state);
      }
      let snapshot: Snapshot;
      try {
        snapshot = await this.ports.github.snapshot(job.repo, entry.pr!);
        screen(job.repo, snapshot.files, snapshot.diff, snapshot.codeowners, this.config);
      } catch { await this.exception(job.id, 'denied-or-unavailable-diff'); continue; }
      const sha = snapshot.pull.head.sha;
      const checks = await this.ports.github.checks(job.repo, sha);
      await this.event('pr-checks', { repo: job.repo, pr: entry.pr, sha, checks });
      if (checks.some(c => ['failure', 'error', 'cancelled', 'timed_out', 'action_required'].includes(c.state))) {
        if (entry.attempts < 2) { entry.stage = 'queued'; await this.ports.save(this.state); }
        else await this.exception(job.id, 'red-ci');
        return;
      }
      if (!green(checks, this.config.requiredChecks[job.repo])) continue;
      let verdict: Verdict;
      try { verdict = await this.ports.review(this.config, snapshot.diff, this.rules); }
      catch { verdict = { verdict: 'reject', reasons: ['uncertain'] }; }
      entry.verdict = verdict.verdict; entry.sha = sha;
      await this.event('review', { repo: job.repo, pr: entry.pr, sha, verdict: verdict.verdict, reasons: verdict.reasons });
      if (verdict.verdict !== 'approve') { await this.exception(job.id, verdict.reasons.includes('security') ? 'security-finding' : 'review-rejected'); continue; }
      // Re-fetch the complete diff and deny-only owner policy at the reviewed head.
      const latest = await this.ports.github.snapshot(job.repo, entry.pr!);
      if (latest.pull.head.sha !== sha || latest.pull.base.sha !== snapshot.pull.base.sha || latest.diff !== snapshot.diff ||
          JSON.stringify(latest.files) !== JSON.stringify(snapshot.files) || latest.codeowners !== snapshot.codeowners) {
        entry.verdict = null; await this.ports.save(this.state); continue;
      }
      screen(job.repo, latest.files, latest.diff, latest.codeowners, this.config);
      const main = await this.ports.github.main(job.repo);
      if (!green(main.checks, this.config.requiredChecks[job.repo]) || !green(await this.ports.github.checks(job.repo, sha), this.config.requiredChecks[job.repo])) return;
      if (!withinCap(this.state, job.repo, this.ports.now(), this.config.dailyCap) || await this.ports.paused() || !(await this.ports.authorized())) return;
      entry.stage = 'reserved'; this.state.reservations.push({ repo: job.repo, pr: entry.pr!, sha, at: this.ports.now(), settled: false });
      await this.ports.save(this.state);
      // Security must attest that server-side stale-review dismissal is enforced.
      // The commit-bound approval then ceases to authorize a later push, including
      // pushes racing between this check and GitHub executing auto-merge.
      try {
        await this.ports.github.approve(job.repo, entry.pr!, sha);
        const head = await this.ports.github.pull(job.repo, entry.pr!);
        if (head.head.sha !== sha || head.base.sha !== snapshot.pull.base.sha || await this.ports.paused() || !(await this.ports.authorized())) {
          entry.stage = 'review'; await this.ports.save(this.state); return;
        }
        await this.ports.github.enable(job.repo, entry.pr!, sha);
      } catch {
        this.state.halt = 'unknown-outcome'; await this.ports.save(this.state);
        await this.cancel(job.id, entry); await this.exception(job.id, 'merge-unknown'); return;
      }
      entry.stage = 'enabled'; await this.ports.save(this.state);
      await this.event('auto-enabled', { repo: job.repo, pr: entry.pr, sha, verdict: entry.verdict });
      return;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function privateFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid?.() || await realpath(path) !== resolve(path) || info.size > 1048576) throw new Error('private-file-required');
  return readFile(path, 'utf8');
}
export async function sourceDigest(): Promise<string> {
  const names = ['policy.ts', 'process.ts', 'review-worker.ts', 'github.ts', 'supervisor.ts'];
  return hash((await Promise.all(names.map(name => readFile(new URL(name, import.meta.url), 'utf8')))).join('\0'));
}
export async function once(control: string): Promise<void> {
  control = await realpath(control);
  const info = await stat(control);
  if ((info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error('private-control-directory-required');
  const lock = join(control, 'tick.lock'); await mkdir(lock, { mode: 0o700 });
  try {
    const configText = await privateFile(join(control, 'config.json'));
    const config = configFrom(JSON.parse(configText));
    const home = await realpath(config.supervisorHome);
    if (home !== config.supervisorHome || home === control || !relative(home, control).startsWith('..') || !relative(control, home).startsWith('..')) throw new Error('separate-home-required');
    const homeInfo = await stat(home);
    if ((homeInfo.mode & 0o077) || homeInfo.uid !== process.getuid?.()) throw new Error('private-home-required');
    const rules = await privateFile(join(control, 'ENGINEER-RULES.md'));
    if (!rules.trim()) throw new Error('rules-required');
    const source = await sourceDigest();
    const authorized = async (): Promise<boolean> => {
      try {
      if (!(await exists(join(control, 'security-approval.json')))) return false;
      const a = object(JSON.parse(await privateFile(join(control, 'security-approval.json'))));
      keys(a, ['source', 'policy', 'rules', 'expiresAt', 'staleReviewsDismissed', 'requiredApprovals', 'credentialScopeVerified', 'hardLimitsMapped', 'isolationVerified']);
      return a.source === source && a.source === await sourceDigest() && a.policy === hash(configText) && a.rules === hash(rules) &&
        a.staleReviewsDismissed === true && a.requiredApprovals === true && a.credentialScopeVerified === true && a.hardLimitsMapped === true && a.isolationVerified === true &&
        typeof a.expiresAt === 'number' && a.expiresAt > Date.now() && a.expiresAt <= Date.now() + 7 * 86400000 &&
        configText === await privateFile(join(control, 'config.json')) && rules === await privateFile(join(control, 'ENGINEER-RULES.md'));
      } catch { return false; }
    };
    const statePath = join(control, 'fleet.json');
    // Missing state is only allowed with a one-use explicit initialization marker.
    let state: State;
    if (await exists(statePath)) state = stateFrom(await privateFile(statePath), config);
    else {
      if (await privateFile(join(control, 'INITIALIZE')) !== 'initialize\n') throw new Error('initialization-required');
      state = initial();
    }
    const save = async (s: State): Promise<void> => {
      const tmp = join(control, 'fleet.next');
      await writeFile(tmp, JSON.stringify(s) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(tmp, statePath);
    };
    await save(state);
    if (await exists(join(control, 'INITIALIZE'))) await rm(join(control, 'INITIALIZE'));
    const audit = async (event: Record<string, unknown>): Promise<void> => {
      // Every value originates from bounded schemas; no errors, prompts or diff text.
      await writeFile(join(control, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600, flag: 'a' });
    };
    const gh = new GitHub(config);
    const supervisor = new Supervisor(config, rules, state, { github: gh, review: freshReview, authorized,
      paused: () => exists(join(control, 'PAUSE')), save, audit, now: Date.now,
      wake: async event => { await isolatedRun(config, config.box, JSON.stringify({ exception: event }), [control, home], 120000); },
      dispatch: (job, repair) => dispatch(config, config.pools[job.pool], JSON.stringify({ repo: job.repo, prompt: job.prompt, rules, repairPr: repair,
        limits: { maxAttempts: 2, maxMergesPerRepoPerHour: 3, dailyCap: config.dailyCap } }), [control, home, fileURLToPath(new URL('.', import.meta.url))]),
    });
    // A box clears a latched halt by writing the exact current halt code.
    if (state.halt && await exists(join(control, 'CLEAR-HALT'))) {
      if ((await privateFile(join(control, 'CLEAR-HALT'))).trim() === state.halt) {
        state.halt = null; state.acknowledged.push(...state.reverted); state.reverted = []; await save(state); await audit({ type: 'box-cleared', at: Date.now() });
        await rm(join(control, 'CLEAR-HALT'));
      }
    }
    // Reconcile stop flags before queue I/O, including a missing/unreadable queue.
    if (state.halt || await exists(join(control, 'PAUSE')) || !(await authorized())) { await supervisor.tick([], false); return; }
    let queueText = '';
    let jobs: Job[];
    try { queueText = await readFile(join(control, 'router-queue.md'), 'utf8'); jobs = queueFrom(queueText, config); }
    catch {
      await audit({ type: 'queue-rejected', at: Date.now(), digest: hash(queueText) });
      // Invalid queue never prevents cancellation/health reconciliation.
      await supervisor.tick([], false, false); return;
    }
    await supervisor.tick(jobs);
  } finally { await rm(lock, { recursive: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const control = process.argv[2];
  if (!control || process.argv.length !== 3) { process.stderr.write('usage: node --import tsx contrib/router/supervisor.ts CONTROL_DIRECTORY\n'); process.exitCode = 1; }
  else once(control).catch(() => { process.stderr.write('rq-supervisor: stopped; inspect structured state and operator prerequisites\n'); process.exitCode = 1; });
}
