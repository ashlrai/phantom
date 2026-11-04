import { explainRoutes } from '../core/queue/route-explain.js';

export async function cmdRoute(args: string[]): Promise<number> {
  if (args[0] !== 'explain' || args.slice(1).some(a => a !== '--json') || args.length > 2) {
    console.error('Usage: phm route explain [--json]');
    return 2;
  }
  const report = await explainRoutes();
  console.log(args.includes('--json') ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  return 0;
}
