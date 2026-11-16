import { readIdeas } from '../core/fleet/ideas.js';

export async function cmdIdeas(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: phm ideas [--json]');
    return 0;
  }
  if (args.some(arg => arg !== '--json') || args.length > 1) {
    console.error('Usage: phm ideas [--json]');
    return 2;
  }
  try {
    const report = await readIdeas();
    console.log(args.includes('--json') ? JSON.stringify(report) : report.ideas.map(i => `${i.id} · ${i.repo ?? 'unknown repo'} · ${i.lane ?? 'unknown lane'}: ${i.goal}`).join('\n') || 'No ideas yet.');
    return 0;
  } catch {
    console.error('Could not read ideas.');
    return 1;
  }
}
