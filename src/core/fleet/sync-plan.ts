import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DriftFile, DriftReport } from './drift.js';

const run = promisify(execFile);

export type SyncAction = 'copy' | 'skip';
export interface SyncStep { step: 'backup' | 'syntax' | 'copy' | 'verify'; detail: string }
export interface SyncPlanRow {
  file: string;
  action: SyncAction;
  /** Plain words: why this file is copied or left alone. */
  reason: string;
  from: string | null;
  to: string;
  /** Present for copy rows: the exact steps, in order. Nothing has run. */
  steps: SyncStep[];
}
export interface SyncPlan {
  schema: 'fleet.sync-plan.v1';
  dryRun: true;
  runtimeDir: string;
  /** Backup suffix every backup in this plan would use. */
  backupStamp: string;
  rows: SyncPlanRow[];
  counts: { copy: number; skip: number };
}

export interface SyncDeps {
  /** Syntax check for one repo file: null when fine or not checkable, else the error line. */
  syntax?: (path: string) => Promise<string | null>;
}

const PY_PARSE = 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read(),sys.argv[1])';

/** bash -n for shell, an ast parse for Python, JSON.parse for JSON; reads only, never executes the file. */
export async function checkSyntax(path: string): Promise<string | null> {
  const ext = extname(path);
  try {
    if (ext === '.sh') await run('bash', ['-n', path], { timeout: 15_000 });
    else if (ext === '.py') await run('python3', ['-I', '-c', PY_PARSE, path], { timeout: 15_000 });
    else if (ext === '.json') JSON.parse(await readFile(path, 'utf8'));
    return null;
  } catch (error) {
    const text = (error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : '');
    return text.trim().split('\n')[0]?.slice(0, 200) || 'syntax check failed';
  }
}

const stampOf = (at: string): string => at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

async function rowFor(f: DriftFile, report: DriftReport, syntax: (path: string) => Promise<string | null>): Promise<SyncPlanRow | null> {
  const to = resolve(report.runtimeDir, f.file);
  const from = f.source ? resolve(report.repo, f.source) : null;
  const skip = (reason: string): SyncPlanRow => ({ file: f.file, action: 'skip', reason, from, to, steps: [] });
  if (f.state === 'same') return null;
  if (f.protectedReason) return skip(`protected: ${f.protectedReason}; only its owner installs it`);
  if (f.state === 'live_only') return skip(f.source ? 'the live copy has edits newer than the repo; review before overwriting' : 'live only; the repo has no copy to install');
  if (!from) return skip('the repo has no copy to install');
  const broken = await syntax(from);
  if (broken) return skip(`syntax check failed: ${broken}`);
  const steps: SyncStep[] = [];
  if (f.state === 'repo_newer') steps.push({ step: 'backup', detail: `copy ${to} to ${to}.bak-fleet-${stampOf(report.asOf)}` });
  steps.push({ step: 'syntax', detail: `${extname(from) === '.py' ? 'python ast parse' : extname(from) === '.sh' ? 'bash -n' : 'no checker for this file type'}: passed on ${from}` });
  steps.push({ step: 'copy', detail: `copy ${from} to ${to}` });
  steps.push({ step: 'verify', detail: `sha256 of ${to} must equal ${f.sourceSha256}` });
  return { file: f.file, action: 'copy', reason: f.state === 'missing' ? 'not installed yet' : 'the repo copy is newer', from, to, steps };
}

/** Pure plan from a drift report; checks syntax of repo sources but writes nothing anywhere. */
export async function planFleetSync(report: DriftReport, deps: SyncDeps = {}): Promise<SyncPlan> {
  const rows: SyncPlanRow[] = [];
  for (const f of report.files) {
    const row = await rowFor(f, report, deps.syntax ?? checkSyntax);
    if (row) rows.push(row);
  }
  const copy = rows.filter(r => r.action === 'copy').length;
  return { schema: 'fleet.sync-plan.v1', dryRun: true, runtimeDir: report.runtimeDir, backupStamp: stampOf(report.asOf), rows, counts: { copy, skip: rows.length - copy } };
}
