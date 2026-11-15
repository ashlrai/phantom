/**
 * `ashlr fleet desktop-errors [--since 24h] [--json]` — the agent-facing view
 * of desktop render crashes (RQ-PHX-DESKTOPCRASHREPORT100).
 *
 * Every error boundary POST lands one JSONL record in
 * `~/.ashlr-runs/desktop/errors.jsonl` via POST /api/verse/desktop-errors.
 * This verb groups that ledger by crash fingerprint — surface, count, last
 * seen, message — so an agent sees "which pane crashes and how often"
 * without Mason pasting a stack. READ-ONLY; it never writes the ledger,
 * resolves a crash, or contacts anything but the filesystem.
 *
 * --since takes a duration: <n>s | <n>m | <n>h | <n>d (default 24h).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDesktopErrors, type DesktopErrorGroup } from '../core/verse/desktop-error-report.js';

const usage = 'usage: ashlr fleet desktop-errors [--since 24h] [--json]';
const DEFAULT_SINCE_MS = 24 * 3_600_000;
const LIMIT = 50;
const DURATION = /^(\d{1,4})([smhd])$/;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** ASHLR_RUNS_DIR overrides ~/.ashlr-runs — the fleet runs-dir convention. */
function defaultRunsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

function parseSince(raw: string): number | null {
  const match = DURATION.exec(raw);
  if (match === null) return null;
  const unit = UNIT_MS[match[2]!];
  const value = Number(match[1]) * unit!;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** One line per crash group: surface, count, last seen, message (pure). */
export function formatDesktopErrorGroups(groups: readonly DesktopErrorGroup[]): string[] {
  return groups.map((group) => {
    const message = group.message.replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${group.surface}  x${group.count}  ${group.lastSeen}  ${message}`;
  });
}

export async function cmdFleetDesktopErrors(args: string[], deps: { runsDir?: string } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  let sinceMs = DEFAULT_SINCE_MS;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      if (json) { process.stderr.write(`${usage}\n`); return 2; }
      json = true;
    } else if (arg === '--since') {
      const parsed = args[i + 1] === undefined ? null : parseSince(args[i + 1]!);
      if (parsed === null) { process.stderr.write(`${usage}\n`); return 2; }
      sinceMs = parsed;
      i += 1;
    } else {
      process.stderr.write(`${usage}\n`); return 2;
    }
  }
  let groups: DesktopErrorGroup[];
  try {
    groups = await readDesktopErrors(deps.runsDir ?? defaultRunsDir(), { sinceMs, limit: LIMIT });
  } catch {
    process.stderr.write('error: unable to read desktop errors\n');
    return 1;
  }
  if (json) { console.log(JSON.stringify({ v: 1, errors: groups })); return 0; }
  if (groups.length === 0) { console.log('No desktop errors recorded.'); return 0; }
  for (const line of formatDesktopErrorGroups(groups)) console.log(line);
  return 0;
}
