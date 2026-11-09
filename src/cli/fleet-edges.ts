import { readFleetEdges } from '../core/fleet/fleet-edges.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export async function cmdFleetEdges(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log('Usage: phm fleet edges [--json]\nRead live agent bus message links.'); return 0; }
  if (args.some(arg => arg !== '--json') || args.length > 1) return 2;
  const result = readFleetEdges();
  console.log(args.includes('--json') ? JSON.stringify(sanitizePublicJson(result)) : result.edges === null ? 'Agent message links unknown.' : result.edges.map(edge => `${String(sanitizePublicJson(edge.from.address))} → ${String(sanitizePublicJson(edge.to.address))}: ${edge.messages}`).join('\n') || 'No live agent messages.');
  return result.source === 'unavailable' ? 1 : 0;
}
