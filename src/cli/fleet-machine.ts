import { readFleetMachine } from '../core/fleet/machine.js';

export async function cmdFleetMachine(args: string[]): Promise<number> {
  const usage = 'Usage: phm fleet machine [--json]';
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const m = await readFleetMachine();
  const show = (n: number | null) => n === null ? 'unknown' : String(Math.round(n * 100) / 100);
  console.log(args.includes('--json') ? JSON.stringify(m) : `Load per CPU: ${show(m.loadPerCpu)}\nSwap: ${show(m.swapGb)} GB\nFree disk: ${show(m.diskFreeGb)} GB\nWorktrees: ${show(m.worktrees)}\nRunning workers: ${show(m.runningWorkers)}${m.overloaded ? '\nWarning: load is over 4 times the number of CPUs.' : ''}`);
  return 0;
}
