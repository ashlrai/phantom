import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isQueueTier } from '../core/drive/queue-tier.js';
import { BUS_MIRROR_KNOWN_LANES } from '../core/fleet/bus-mirror-dispatch.js';

const reasons = ['under 5 fields', 'bad id', 'unknown lane', 'unknown tier', 'repo dir missing', 'prompt missing or outside queue/prompts'] as const;
type Reason = typeof reasons[number];
export interface BadReadyRow { line: number; id: string | null; reason: Reason }
export interface ReadyBadReport { counts: Record<Reason, number>; rows: BadReadyRow[]; total: number }

async function isType(path: string, type: 'file' | 'directory'): Promise<boolean> {
  try { const info = await stat(path); return type === 'file' ? info.isFile() : info.isDirectory(); } catch { return false; }
}

/** Diagnose in dispatcher order; each row receives only its first failing reason. */
export async function inspectReadyBad(text: string, runsDir: string, home: string): Promise<ReadyBadReport> {
  const counts = Object.fromEntries(reasons.map(reason => [reason, 0])) as Record<Reason, number>;
  const rows: BadReadyRow[] = [];
  let total = 0;
  const prompts = join(runsDir, 'queue', 'prompts');
  let realPrompts: string | undefined;
  try { realPrompts = await realpath(prompts); } catch { /* Missing prompts makes every prompt invalid. */ }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const fields = line.split('\t');
    const [id = '', repo = '', lane = '', tier = '', prompt = ''] = fields;
    let reason: Reason | undefined;
    if (fields.length < 5) reason = reasons[0];
    else if (!/^[A-Za-z0-9._-]+$/.test(id)) reason = reasons[1];
    else if (!BUS_MIRROR_KNOWN_LANES.has(lane)) reason = reasons[2];
    else if (!isQueueTier(tier)) reason = reasons[3];
    else if (!repo || repo === '.' || repo === '..' || repo.includes('/') || repo.includes('\\') || !(await isType(join(home, 'Projects', 'ashlrai', repo), 'directory'))) reason = reasons[4];
    else {
      let realPrompt: string | undefined;
      try { if (isAbsolute(prompt)) realPrompt = await realpath(prompt); } catch { /* Missing prompt. */ }
      const rel = realPrompt && realPrompts ? relative(realPrompts, realPrompt) : '';
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await isType(realPrompt!, 'file'))) reason = reasons[5];
    }
    if (reason) {
      counts[reason]++; total++;
      // Do not echo arbitrary queue fields: they can contain prompt content or terminal controls.
      if (rows.length < 10) rows.push({ line: i + 1, id: /^[A-Za-z0-9._-]{1,100}$/.test(id) ? id : null, reason });
    }
  }
  return { counts, rows, total };
}

const usage = 'Usage: phm fleet ready-bad [--json]\nShow invalid ready queue rows and the first reason each cannot run. Read-only.';
export async function cmdFleetReadyBad(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const root = resolve(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
  let text: string;
  try { text = await readFile(join(root, 'queue', 'ready.tsv'), 'utf8'); }
  catch { console.error('error: unable to read queue/ready.tsv'); return 1; }
  const report = await inspectReadyBad(text, root, homedir());
  if (args[0] === '--json') console.log(JSON.stringify(report));
  else {
    console.log(`Invalid ready rows: ${report.total}`);
    for (const reason of reasons) console.log(`${reason}: ${report.counts[reason]}`);
    for (const row of report.rows) console.log(`line ${row.line}: ${row.id ?? '(invalid id)'} — ${row.reason}`);
  }
  return 0;
}
