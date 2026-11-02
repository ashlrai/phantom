import { grokUltraFleetPath, readGrokUltraRunway, recordManualGrokUltraReading } from '../core/fleet/grok-ultra-store.js';
import { emitGrokUltraRunway } from '../core/fleet/grok-ultra-telemetry.js';
import type { GrokUltraRunway } from '../core/fleet/grok-ultra-types.js';

const HELP = `Usage:
  phm fleet grok-usage status [--file /absolute/path/fleet.json] [--json]
  phm fleet grok-usage record --remaining-points N --total-points N [--at ISO-UTC] [--file /absolute/path/fleet.json] [--json]

Manual fallback: enter points shown by the signed-in app. No app credentials or browser access.
Status is read-only. Record persists a manual reading and emits configured PostHog telemetry.
`;

function show(runway: GrokUltraRunway): string {
  const lines = [`Grok Ultra: ${runway.state} (manual fallback)`,
    'Landing target: Sun Nov 1, 2026 8:21 PM ET'];
  if (runway.latest) lines.push(`${runway.latest.remainingPoints} / ${runway.latest.totalPoints} points remaining; ${runway.latest.source} at ${runway.latest.timestamp}`);
  for (const k of ['h1', 'h6', 'h24'] as const) lines.push(
    `${k.slice(1)}h burn: ${runway.burnPointsPerHour[k] ?? 'unknown'} points/hour; landing: ${runway.projectedRemainingPoints[k] ?? 'unknown'} points`);
  return lines.join('\n');
}

export async function cmdFleetGrokUsage(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { process.stdout.write(HELP); return 0; }
  const [verb, ...rest] = args;
  if (verb !== 'status' && verb !== 'record') { process.stderr.write(HELP); return 2; }
  const options = new Map<string, string>();
  let json = false;
  const allowed = verb === 'record'
    ? ['--file', '--at', '--remaining-points', '--total-points'] : ['--file'];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (!allowed.includes(flag) || options.has(flag) || !rest[i + 1] || rest[i + 1]!.startsWith('--')) {
      process.stderr.write('Invalid grok-usage arguments. Use --help.\n'); return 2;
    }
    options.set(flag, rest[++i]!);
  }
  if (verb === 'record' && (!options.has('--remaining-points') || !options.has('--total-points'))) {
    process.stderr.write('Both --remaining-points and --total-points are required.\n'); return 2;
  }
  try {
    const file = options.get('--file') ?? grokUltraFleetPath();
    if (verb === 'status') {
      const runway = await readGrokUltraRunway(file);
      process.stdout.write(json ? JSON.stringify(runway) + '\n' : show(runway) + '\n');
      return runway.state === 'unavailable' ? 1 : 0;
    }
    const timestamp = options.get('--at') ?? new Date().toISOString();
    // Decimal only: reject empty strings, hex, Infinity and exponent typos.
    const numeric = (name: string): number => {
      const raw = options.get(name)!;
      return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    };
    const runway = recordManualGrokUltraReading({ timestamp,
      remainingPoints: numeric('--remaining-points'), totalPoints: numeric('--total-points') }, file);
    const telemetry = await emitGrokUltraRunway(runway);
    process.stdout.write(json ? JSON.stringify({ ...runway, telemetry }) + '\n' : `${show(runway)}\nPostHog: ${telemetry}\n`);
    // Persistence succeeded even when analytics failed; an identical retry is safe.
    return telemetry === 'failed' ? 1 : 0;
  } catch {
    // Never reflect supplied paths, values or exceptions into shared bridge logs.
    process.stderr.write('Grok usage was not recorded. Check the reading, file permissions, ordering and store lock.\n');
    return 1;
  }
}
