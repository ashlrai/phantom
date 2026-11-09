import { ACTION_CLASSES_SCHEMA, actionClassesProjection } from '../core/authority/action-classes.js';

/**
 * `phm fleet action-classes` — print the unified action-class autonomy registry
 * (RQ-SWE5-ACTION-CLASSES): every class with its gate policy, blast radius and
 * reversibility, plus the job-prefix map and publishable gates dispatchd and
 * publish.sh consult. Read-only; the registry is a compiled constant and the
 * installed Mac copy is the JSON projection under contrib/mac/.
 */

const USAGE = `Usage: ashlr fleet action-classes [--json]
Print the unified action-class autonomy registry: gate policy, blast radius and
reversibility for each class, plus the job-prefix map and publishable gates.
Read-only. Exits 2 on unknown arguments.`;

export async function cmdFleetActionClasses(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const projection = actionClassesProjection();
  if (args.includes('--json')) {
    console.log(JSON.stringify(projection));
    return 0;
  }
  const classes = projection.classes as Record<string, { gate: string; blastRadius: string; reversibility: string; summary: string }>;
  const lines = [`Action-class registry ${ACTION_CLASSES_SCHEMA}:`];
  for (const [name, entry] of Object.entries(classes)) {
    lines.push(`${name}: gate=${entry.gate} blast=${entry.blastRadius} reversibility=${entry.reversibility} — ${entry.summary}`);
  }
  const jcm = projection.jobClassMap as { prefixes: [string, string][]; default: string };
  lines.push(`job prefixes: ${jcm.prefixes.map(([p, c]) => `${p}* -> ${c}`).join(', ') || 'none'}; default -> ${jcm.default}`);
  lines.push(`publishable gates: ${(projection.publishableGates as string[]).join(', ')}`);
  console.log(lines.join('\n'));
  return 0;
}
