import { readKeptLanded } from '../core/fleet/kept-landed.js';

export async function cmdFleetKeptLanded(args: string[], read = readKeptLanded): Promise<number> {
  const usage = 'Usage: phm fleet kept-landed [--json] [--older-than 72h]\nTracked changes only; untracked and ignored content are outside this proof. Sizes may be partial. Uses local origin/master, which may be stale. No removal authority.';
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let hours = 0, json = false, hasAge = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--older-than' && !hasAge && /^\d+(?:\.\d+)?h$/.test(args[i + 1] ?? '')) { hasAge = true; hours = Number(args[++i]!.slice(0, -1)); }
    else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours)) { console.error(usage); return 2; }
  try {
    const report = await read({ olderThanHours: hours });
    console.log(json ? JSON.stringify(report) : report.summary);
    return 0;
  } catch { console.error('fleet kept-landed: worktree root unavailable'); return 1; }
}
