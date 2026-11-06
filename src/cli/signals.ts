import { readSignals } from '../core/signals.js';
export async function cmdSignals(args: string[]): Promise<number> {
  if (args.some(arg => arg !== '--json')) {
    console.error('Usage: phm signals [--json]');
    return 2;
  }
  console.log(JSON.stringify(await readSignals(process.cwd()), null, 2));
  return 0;
}
