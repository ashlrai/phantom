import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { buildPlannerBrief, writePlannerBrief } from '../core/fleet/planner-brief.js';

type IO = { stdout?: { write(text: string): unknown } };

export async function cmdFleetPlannerBrief(args: string[], io: IO = {}): Promise<number> {
  const output = io.stdout ?? process.stdout;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const bad = (): number => { output.write('Invalid planner-brief flags\n'); return 2; };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (['--write', '--json'].includes(flag) && !flags.has(flag)) { flags.add(flag); continue; }
    if (!['--runs-dir', '--repo', '--note'].includes(flag) || values.has(flag)) return bad();
    const value = args[++i];
    if (value === undefined || value.startsWith('--') || value.includes('\0')) return bad();
    if (flag !== '--note' && !isAbsolute(value)) return bad();
    values.set(flag, value);
  }
  const runsRoot = values.get('--runs-dir') ?? join(homedir(), '.ashlr-runs');
  try {
    const brief = await buildPlannerBrief({ runsRoot, repoRoot: values.get('--repo'), note: values.get('--note') });
    const written = flags.has('--write') ? writePlannerBrief(runsRoot, brief.text) : undefined;
    const report = { v: brief.v, sections: brief.sections, missing: brief.missing, ...(written ?? {}) };
    output.write(flags.has('--json') ? `${JSON.stringify(report)}\n` :
      `${Object.entries(brief.sections).map(([key, count]) => `${key}: ${count}`).join('\n')}\nmissing: ${brief.missing.join(', ') || '(none)'}\n${written ? `${written.path} (${written.bytes} bytes)\n` : ''}`);
    return brief.missing.includes('leader/ORCHESTRATION.md') ? 1 : 0;
  } catch {
    output.write('Unable to write planner brief\n');
    return 1;
  }
}
