/** Recent-outcome rules shared by EMPTYSTOP and RECUTGATE; no separate stop ledger. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ledgerJobId } from './empty-cause.js';
import { readLedgerLines } from './ledger-lines.js';
import { yieldTally, jobKind, type YieldRun } from './slot-yield.js';
import { readSource } from './runs-parked-queue.js';

export const familyKey = (id: string): string => jobKind(id.toUpperCase().replace(/C\d+[A-Z]*$/, '')).replace(/^RQ-(?:PHX-)?/, '').replace(/^LAND[A-Z]+DIRTY$/, 'LAND*DIRTY');
export interface FamilyStop { key: string; reason: string; until: number; evidence: string[] }
export function familyStops(runs: readonly YieldRun[], reasons: ReadonlyMap<string, string>, now: number): FamilyStop[] {
  const groups = new Map<string, YieldRun[]>();
  for (const run of runs) { const key = familyKey(run.job); const group = groups.get(key) ?? []; group.push(run); groups.set(key, group); }
  return [...groups].flatMap(([key, members]) => {
    if (/FIXUP|RELEASE/.test(key) || members.some(r => r.merged)) return [];
    const recent = members.sort((a, b) => b.at - a.at).slice(0, 6);
    const empty = members.filter(r => r.empty && r.prs.size === 0 && reasons.get(r.job) === 'no eligible PR').sort((a, b) => b.last - a.last)[0];
    const yieldStop = recent.length === 6 && recent.every(r => r.finished && r.prs.size === 0);
    const until = Math.max(empty ? empty.last + 2 * 3_600_000 : 0, yieldStop ? Math.max(...recent.map(r => r.last)) + 24 * 3_600_000 : 0);
    if (until <= now) return [];
    const lowYield = yieldStop && Math.max(...recent.map(r => r.last)) + 24 * 3_600_000 === until;
    return [{ key, until, reason: lowYield ? 'no PRs in the last 6 launches' : `${empty!.job.replace(/^RQ-(?:PHX-)?/, '')} found no eligible PR`, evidence: lowYield ? recent.map(r => r.job) : [empty!.job] }];
  });
}
export async function readFamilyStops(metrics: string, now = Date.now()) {
  const tally = yieldTally(now, now / 3_600_000 + 1), reasons = new Map<string, string>();
  let malformed = false;
  const readable = await readLedgerLines(metrics, line => {
    if (!line.trim()) return;
    try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { malformed = true; return; } const r = parsed as Record<string, unknown>; tally.add(line); const id = ledgerJobId(r); if (id && /no eligible|no[ _-]candidate/i.test(String(r.reason ?? ''))) reasons.set(id, 'no eligible PR'); } catch { malformed = true; }
  });
  const known = readable && !malformed;
  const runs = tally.runs();
  for (const run of runs.filter(r => r.empty && r.last > now - 2 * 3_600_000)) {
    if (!/^[A-Za-z0-9._-]+$/.test(run.job)) continue;
    const root = join(metrics, '..', '..');
    const texts = await Promise.all(['log', 'publish'].map(ext => readSource(join(root, `${run.job}.${ext}`), 65536, true)));
    if (texts.some(t => /\bno eligible\b|\bno[ _-]candidate\b|\bno suitable (?:PR|pull request)\b/i.test(t.text.split(/\r?\n/).slice(-40).join('\n')))) reasons.set(run.job, 'no eligible PR');
  }
  return { schema: 'jobs.family-stops.v1' as const, known, stops: known ? familyStops(runs, reasons, now) : [], launched: new Set(runs.map(r => r.job)) };
}
export const familyStopLine = (s: FamilyStop): string => `${s.key} stopped until ${new Date(s.until).toISOString().slice(11, 16)} UTC: ${s.reason}`;

/** Use the dispatcher's ready.lock; recheck claims and launches while holding it. Touch queue rows only. */
const PRUNE = `import fcntl,json,os,re,sys
root,ids,apply=sys.argv[1],set(json.loads(sys.argv[2])),sys.argv[3]=='true'
q=os.path.join(root,'queue')
with os.fdopen(os.open(os.path.join(q,'ready.lock'),os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600),'a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 def read(p,required=False):
  try:
   if os.path.islink(p): raise ValueError('queue symlink')
   return open(p).read()
  except FileNotFoundError:
   if required: raise ValueError('Required evidence missing; nothing removed')
   return ''
 for line in read(os.path.join(root,'metrics/jobs.jsonl'),True).splitlines():
  if not line.strip(): continue
  try: row=json.loads(line)
  except ValueError: raise ValueError('Malformed launch evidence; nothing removed')
  if not isinstance(row,dict): raise ValueError('Invalid launch evidence; nothing removed')
  if (row.get('event') or row.get('type') or row.get('kind') or '').lower()=='launch': ids.discard(row.get('job') or row.get('job_id') or row.get('jobId') or row.get('id'))
 ids-=set(x.split('\\t')[0] for x in read(os.path.join(q,'claimed.tsv'),True).splitlines())
 removed=[]
 for name in ['router-queue.md','ready.tsv']:
  path=os.path.join(q,name); text=read(path); kept=[]
  for line in text.splitlines(True):
   m=re.match(r'^- READY ([A-Za-z0-9._-]+)(?:\\s|$)',line) if name.endswith('.md') else re.match(r'^([A-Za-z0-9._-]+)\\t',line)
   if m and m[1] in ids: removed.append(m[1])
   else: kept.append(line)
  if apply and ''.join(kept)!=text:
   with open(path+'.family-stop.tmp','x') as out: out.write(''.join(kept))
   os.replace(path+'.family-stop.tmp',path)
 print(json.dumps(sorted(set(removed))))
`;
export async function pruneFamilyStops(root: string, apply = false, now = Date.now()) {
  const report = await readFamilyStops(join(root, 'metrics/jobs.jsonl'), now);
  const ids = new Set<string>();
  const claimed = await readSource(join(root, 'queue/claimed.tsv'), 2 * 1024 * 1024, false);
  if (apply && claimed.state !== 'healthy' || claimed.state === 'degraded') throw new Error('Claims unreadable; nothing removed');
  const claims = new Set(claimed.text.split('\n').map(line => line.split('\t')[0]));
  if (report.known) for (const name of ['router-queue.md', 'ready.tsv']) {
    const source = await readSource(join(root, 'queue', name), 2 * 1024 * 1024, false);
    if (source.state === 'degraded') throw new Error('Queue unreadable; nothing removed');
    for (const line of source.text.split('\n')) {
      const id = (name.endsWith('.md') ? /^- READY ([A-Za-z0-9._-]+)(?:\s|$)/ : /^([A-Za-z0-9._-]+)\t/).exec(line)?.[1];
      if (id && !claims.has(id) && !report.launched.has(id) && report.stops.some(s => s.key === familyKey(id))) ids.add(id);
    }
  }
  const removed = !apply ? [...ids] : ids.size ? JSON.parse(execFileSync('python3', ['-I', '-c', PRUNE, root, JSON.stringify([...ids]), String(apply)], { encoding: 'utf8', timeout: 5000 })) as string[] : [];
  return { ...report, launched: undefined, dry_run: !apply, removed };
}
