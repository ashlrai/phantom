import { readKeptLanded } from '../core/fleet/kept-landed.js';

export async function cmdFleetKept(args: string[], read = readKeptLanded): Promise<number> {
  const usage = 'Usage: phm fleet kept [--json] [--older-than 72h]\nRead-only landed check for tracked changes in fleet worktrees; deletes nothing.';
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let hours = 0, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--older-than' && /^\d+(?:\.\d+)?h$/.test(args[i + 1] ?? '')) hours = Number(args[++i]!.slice(0, -1));
    else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours)) { console.error(usage); return 2; }
  try {
    const report = await read({ olderThanHours: hours });
    console.log(json ? JSON.stringify(report) : report.summary);
    return 0;
  } catch { console.error('fleet kept: worktree root unavailable'); return 1; }
}
