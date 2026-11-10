import { readWbLocus } from '../core/workbench/locus.js';

export async function cmdWb(args: string[]): Promise<number> {
  if (args[0] !== 'locus' || args.slice(1).some((arg) => arg !== '--json') || args.length > 2) {
    console.error('Usage: phm wb locus [--json]');
    return 2;
  }
  const reading = await readWbLocus();
  console.log(JSON.stringify(reading, null, 2));
  return 0;
}
