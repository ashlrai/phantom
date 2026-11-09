import { verifyChain } from '../core/chain-verify.js';

export async function cmdChain(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log('Usage: phm chain verify [--json]\nSynthetic, in-memory checks only; does not verify live transports.');
    return 0;
  }
  if (args[0] !== 'verify' || args.slice(1).some(a => a !== '--json') || args.length > 2) {
    console.error('Usage: phm chain verify [--json]');
    return 2;
  }
  const report = await verifyChain();
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else {
    console.log('Synthetic checks only; live providers and transports are not verified.');
    for (const link of report.links) console.log(`${link.link}: ${link.status} (${link.latencyMs === null ? 'not measured' : `${link.latencyMs.toFixed(2)} ms`})`);
  }
  return report.status === 'pass' ? 0 : 1;
}
