import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, open, unlink, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import { ashlrHome } from '../cloud/store.js';
import { scrubSecrets } from '../util/scrub.js';

export interface Routine {
  id: string; schedule: string; prompt?: string; command?: string;
  capabilities: string[]; tier: 'local' | 'mid' | 'frontier'; output: string;
}
export interface Executor {
  id: string; kind: 'codex' | 'claude' | 'devin' | 'omlx' | 'shell';
  capabilities: string[]; tier: Routine['tier']; cost: number; dailyLimit: number;
  codexHome?: string; model?: string; repo?: string;
}
export interface Config { routines: Routine[]; executors: Executor[] }
export interface Attempt {
  routine: string; executor: string; at: string; duration: number; costEstimate: number;
  outcome: 'success' | 'submitted' | 'quota' | 'rate-limit' | 'unhealthy' | 'failed' | 'unavailable'; slot?: string;
}
export type Invoke = (executor: Executor, routine: Routine) => Promise<{ output: string; submitted?: boolean }>;
const tiers = ['local', 'mid', 'frontier'];
const id = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const routinesDir = (): string => join(ashlrHome(), 'routines');

/** Five-field UTC cron; standard day-of-month/day-of-week OR semantics. */
export function scheduleMatches(schedule: string, date: Date): boolean {
  const aliases: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0' };
  const fields = (aliases[schedule] ?? schedule).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Expected five UTC cron fields');
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const matches = fields.map((field, i) => {
    const [min, max] = bounds[i]!;
    return field.split(',').map(part => {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!m) throw new Error('Invalid cron field');
      const [lo, hi] = m[1] === '*' ? [min!, max!] : m[1]!.split('-').map(Number);
      const end = hi ?? (m[2] ? max! : lo!);
      const step = Number(m[2] ?? 1);
      if (lo! < min! || end > max! || lo! > end || step < 1 || step > max! + 1) throw new Error('Cron field out of range');
      return Array.from({ length: end - lo! + 1 }, (_, n) => lo! + n).some(n => (n - lo!) % step === 0 && (i === 4 ? n % 7 : n) === values[i]);
    }).some(Boolean);
  });
  return matches[0]! && matches[1]! && matches[3]! && (fields[2] !== '*' && fields[4] !== '*' ? matches[2]! || matches[4]! : matches[2]! && matches[4]!);
}

export function decodeConfig(text: string): Config {
  if (scrubSecrets(text) !== text) throw new Error('Credentials are forbidden in routine definitions');
  const c = parse(text, { maxAliasCount: 0 }) as Config;
  if (!c || !Array.isArray(c.routines) || !Array.isArray(c.executors)) throw new Error('Expected routines and executors arrays');
  const unique = new Set<string>();
  for (const r of c.routines) {
    if (!r || !id.test(r.id) || unique.has(r.id) || !tiers.includes(r.tier) || !Array.isArray(r.capabilities) || !r.capabilities.every(x => typeof x === 'string') || typeof r.output !== 'string' || !r.output || isAbsolute(r.output) || r.output.split(/[\\/]/).includes('..') || (typeof r.prompt === 'string') === (typeof r.command === 'string')) throw new Error('Invalid or duplicate routine');
    if (!(r.prompt ?? r.command)?.trim()) throw new Error('Empty routine body');
    unique.add(r.id); scheduleMatches(r.schedule, new Date());
  }
  unique.clear();
  for (const e of c.executors) {
    if (!e || !id.test(e.id) || unique.has(e.id) || !['codex', 'claude', 'devin', 'omlx', 'shell'].includes(e.kind) || !tiers.includes(e.tier) || !Array.isArray(e.capabilities) || !e.capabilities.every(x => typeof x === 'string') || !Number.isFinite(e.cost) || e.cost < 0 || !Number.isSafeInteger(e.dailyLimit) || e.dailyLimit < 0) throw new Error('Invalid or duplicate executor');
    if ([e.codexHome, e.model, e.repo].some(v => v !== undefined && (typeof v !== 'string' || !v))) throw new Error('Invalid executor options');
    unique.add(e.id);
  }
  return c;
}

const exec = promisify(execFile);
export const invoke: Invoke = async (e, r) => {
  if (e.kind === 'devin') {
    if (!e.repo) throw new Error('Devin requires repo');
    const { launchDevinTask } = await import('../devin/service.js');
    const result = await launchDevinTask({ repo: e.repo, prompt: r.prompt!, origin: 'cli' });
    if (!result.ok) throw new Error(result.error ?? 'Devin refused');
    return { output: JSON.stringify({ taskId: result.task?.id }), submitted: true };
  }
  if (e.kind === 'omlx') {
    if (!e.model) throw new Error('oMLX requires model');
    const response = await fetch('http://127.0.0.1:8000/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: e.model, messages: [{ role: 'user', content: r.prompt }] }), signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(response.status === 429 ? 'rate limit' : 'oMLX unhealthy');
    const body = await response.json() as { choices?: { message: { content: string } }[] };
    if (!body.choices?.[0]?.message.content) throw new Error('oMLX empty response');
    return { output: body.choices[0].message.content };
  }
  const model = e.model ?? (r.tier === 'frontier' ? 'opus' : r.tier === 'mid' ? 'sonnet' : 'haiku');
  const args = e.kind === 'shell' ? ['-c', r.command!] : e.kind === 'codex' ? ['exec', ...(e.model ? ['--model', e.model] : []), r.prompt!] : ['-p', r.prompt!, '--model', model, '--output-format', 'json'];
  try {
    const { stdout } = await exec(e.kind === 'shell' ? '/bin/sh' : e.kind, args, { timeout: 300_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, ...(e.codexHome ? { CODEX_HOME: e.codexHome } : {}) } });
    if (e.kind === 'claude') {
      const body = JSON.parse(stdout) as { is_error?: boolean; result?: string };
      if (body.is_error) throw new Error(body.result ?? 'Claude failed');
      return { output: body.result ?? stdout };
    }
    return { output: stdout };
  } catch (error) {
    const x = error as { message?: string; stderr?: string; stdout?: string; code?: string };
    // Inspect privately; never persist provider diagnostics or credentials.
    throw new Error(classify(`${x.message} ${x.stderr} ${x.stdout} ${x.code}`));
  }
};
export function classify(message: string): Attempt['outcome'] {
  if (/quota|usage.?limit|usage.?exhaust|credit|insufficient_quota/i.test(message)) return 'quota';
  if (/rate.?limit|429|too many requests/i.test(message)) return 'rate-limit';
  if (/ENOENT|auth|unhealthy|ECONNREFUSED/i.test(message)) return 'unhealthy';
  return 'failed';
}

export async function history(dir = routinesDir()): Promise<Attempt[]> {
  try { return (await readFile(join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Attempt); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
export function candidates(c: Config, r: Routine, ledger: Attempt[], now: Date): Executor[] {
  return c.executors.filter(e => {
    const today = ledger.filter(a => a.executor === e.id && a.at.slice(0, 10) === now.toISOString().slice(0, 10));
    const last = ledger.filter(a => a.executor === e.id).at(-1);
    const cooldown = last && ({ quota: 3_600_000, 'rate-limit': 60_000, unhealthy: 300_000, failed: 0, success: 0, submitted: 0, unavailable: 0 }[last.outcome]);
    return (e.kind === 'shell') === Boolean(r.command) && tiers.indexOf(e.tier) >= tiers.indexOf(r.tier) && r.capabilities.every(x => e.capabilities.includes(x)) && today.length < e.dailyLimit && !(last && now.getTime() - Date.parse(last.at) < (cooldown || 0));
  }).sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
}
async function save(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
export async function status(c: Config, dir = routinesDir()): Promise<string> {
  const ledger = await history(dir);
  const lines = c.routines.map(r => {
    const last = ledger.filter(a => a.routine === r.id).at(-1);
    return `| ${r.id} | ${r.schedule} | ${last?.executor ?? '—'} | ${last?.outcome ?? 'never'} | ${last?.at ?? '—'} |`;
  });
  const md = ['# Phantom routines', '', 'Schedules use UTC. Costs are operator estimates; daily limits count attempts.', '', '| Routine | Schedule | Executor | Outcome | Last attempt |', '| --- | --- | --- | --- | --- |', ...lines, ''].join('\n');
  await save(join(dir, 'STATUS.md'), md); return md;
}
/** One lock spans dispatch and ledger writes; crash claims prevent duplicate scheduled work. */
export async function run(c: Config, routineId?: string, dir = routinesDir(), call: Invoke = invoke, now = new Date()): Promise<Attempt[]> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = await open(join(dir, '.lock'), 'wx', 0o600);
  try {
    const ledger = await history(dir), result: Attempt[] = [];
    const slot = now.toISOString().slice(0, 16);
    if (routineId && !c.routines.some(r => r.id === routineId)) throw new Error('Unknown routine');
    for (const r of c.routines.filter(r => routineId ? r.id === routineId : scheduleMatches(r.schedule, now))) {
      if (!routineId) {
        await mkdir(join(dir, 'claims'), { recursive: true, mode: 0o700 });
        try { const claim = await open(join(dir, 'claims', `${r.id}-${slot.replace(/:/g, '-')}`), 'wx', 0o600); await claim.close(); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; throw e; }
      }
      const available = candidates(c, r, ledger, now);
      if (!available.length) {
        const a: Attempt = { routine: r.id, executor: 'none', at: now.toISOString(), duration: 0, costEstimate: 0, outcome: 'unavailable', slot };
        await appendFile(join(dir, 'runs.jsonl'), JSON.stringify(a) + '\n', { mode: 0o600 }); ledger.push(a); result.push(a);
      }
      for (const e of available) {
        const start = Date.now();
        const a: Attempt = { routine: r.id, executor: e.id, at: now.toISOString(), duration: 0, costEstimate: e.cost, outcome: 'failed', slot };
        let output: string | undefined;
        try { const value = await call(e, r); output = scrubSecrets(value.output); a.outcome = value.submitted ? 'submitted' : 'success'; }
        catch (error) { a.outcome = classify(String(error)); }
        a.duration = Date.now() - start;
        await appendFile(join(dir, 'runs.jsonl'), JSON.stringify(a) + '\n', { mode: 0o600 });
        ledger.push(a); result.push(a);
        if (output !== undefined) { await save(resolve(dir, 'output', r.output), output); break; }
        if (a.outcome === 'failed') break; // ambiguous failures must not duplicate paid work
      }
    }
    await status(c, dir); return result;
  } finally { await lock.close(); await unlink(join(dir, '.lock')); }
}
export async function load(file = join(routinesDir(), 'routines.yaml')): Promise<Config> { return decodeConfig(await readFile(file, 'utf8')); }
export async function migrate(text: string, routineId: string, file = join(routinesDir(), 'routines.yaml')): Promise<void> {
  let c: Config;
  try { c = await load(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; c = { routines: [], executors: [] }; }
  let cron = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/.exec(text.trim());
  if (cron) { try { scheduleMatches(cron[1]!, new Date()); } catch { cron = null; } }
  c.routines.push({ id: routineId, schedule: cron?.[1] ?? '@daily', ...(cron ? { command: cron[2]! } : { prompt: text }), capabilities: [cron ? 'shell' : 'research'], tier: cron ? 'local' : 'mid', output: `${routineId}.md` });
  await save(file, stringify(decodeConfig(stringify(c))));
}
export function launchdPlist(node: string, cli: string, file: string): string {
  const xml = (s: string): string => s.replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]!);
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>ai.ashlr.routines</string><key>ProgramArguments</key><array>${[node, cli, 'routines', 'tick', '--file', file].map(x => `<string>${xml(x)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict><key>StartInterval</key><integer>60</integer></dict></plist>`;
}
