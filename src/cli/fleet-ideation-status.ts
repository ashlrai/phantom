import { isAbsolute } from 'node:path';
import { readIdeationStatus, type IdeationStatusReport } from '../core/research/ideation-status.js';

const USAGE = 'Usage: ashlr fleet ideation-status --config <absolute.json> [--days N] [--json]\n' +
  'Report what the daily ideation loop did on recent UTC days (read-only; proposal ids only).\n' +
  'N is 1..30 (default 7).\n';

export async function cmdFleetIdeationStatus(
  args: string[], deps: { read?: (config: string, days: number) => Promise<IdeationStatusReport> } = {},
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE); return 0; }
  const reject = (message: string): number => { process.stderr.write(`${message}\n${USAGE}`); return 2; };
  let config: string | undefined, days = 7, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { json = true; continue; }
    if (arg !== '--config' && arg !== '--days') return reject('Unknown argument.');
    if (seen.has(arg)) return reject('Duplicate argument.');
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) return reject(`Missing value for ${arg}.`);
    seen.add(arg); i++;
    if (arg === '--config') config = value;
    else {
      if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 30) return reject('--days must be 1..30.');
      days = Number(value);
    }
  }
  if (config === undefined || !isAbsolute(config)) return reject('--config must be an absolute path.');
  let report: IdeationStatusReport | undefined;
  try { report = await (deps.read ?? ((c, d) => readIdeationStatus(c, { days: d })))(config, days); }
  catch { /* fixed fallback below */ }
  if (!report) { process.stdout.write(JSON.stringify({ status: 'unavailable' }) + '\n'); return 1; }
  if (json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return 0; }
  const lines = report.rows.map(r => `${r.day}  ${r.state}${r.state === 'completed' ? `  ${r.selected.length} selected` : ''}${r.strategyDoc ? '  doc' : ''}`);
  lines.push(`state dir: ${report.stateDir}; last completed: ${report.lastCompleted ?? 'never'}; missing streak: ${report.streakMissing}`);
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
