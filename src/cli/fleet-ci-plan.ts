import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { planCiDaily } from '../core/fleet/ci-daily-plan.js';
import type { WorkflowTriggerPlan } from '../core/fleet/ci-daily-plan.js';

const usage = 'ashlr fleet ci-plan [--patch] [--json] [--cron "<minute hour day month dow>"]';

/** .github/workflows in the containing worktree; walking up stops at a .git root. */
function workflowsDir(cwd: string): string | null {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, '.github', 'workflows');
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch { /* not here */ }
    try {
      statSync(join(dir, '.git'));
      return null; // worktree root reached without a workflows folder
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function cronIsValid(expr: string): boolean {
  return expr.trim().split(/\s+/).length === 5;
}

function row(plan: WorkflowTriggerPlan): string[] {
  return [
    plan.file.split('/').pop() ?? plan.file,
    plan.action,
    plan.removed.join(', ') || '-',
    plan.kept.join(', ') || '-',
    plan.cron ?? '-',
  ];
}

export async function cmdFleetCiPlan(args: string[], deps: { cwd?: string } = {}): Promise<number> {
  let patch = false, json = false, cron: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { console.log(`usage: ${usage}`); return 0; }
    if (args[i] === '--patch' && !patch) { patch = true; continue; }
    if (args[i] === '--json' && !json) { json = true; continue; }
    if (args[i] === '--cron' && cron === undefined && args[i + 1]) { cron = args[++i]!; continue; }
    process.stderr.write(`Invalid argument: ${args[i]}\nusage: ${usage}\n`); return 2;
  }
  if (cron !== undefined && !cronIsValid(cron)) {
    process.stderr.write(`Invalid --cron expression (needs five fields): ${cron}\nusage: ${usage}\n`); return 2;
  }

  const dir = workflowsDir(deps.cwd ?? process.cwd());
  if (dir === null) {
    process.stderr.write('No .github/workflows folder found in this working tree.\nusage: ' + usage + '\n');
    return 2;
  }
  const files = readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ file: join('.github', 'workflows', name), text: readFileSync(join(dir, name), 'utf8') }));

  const result = planCiDaily(files, cron === undefined ? {} : { cron });

  if (patch) {
    process.stdout.write(result.patch);
    process.stderr.write(result.patch ? '# apply with: git apply\n' : 'nothing to apply\n');
    return 0;
  }
  if (json) {
    console.log(JSON.stringify(result));
    return 0;
  }

  const rows = [['FILE', 'ACTION', 'REMOVED', 'KEPT', 'CRON'], ...result.plans.map(row)];
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  for (const r of rows) console.log(r.map((cell, c) => cell.padEnd(widths[c]!)).join('  ').trimEnd());
  console.log(`\n${result.summary}`);
  if (!result.plans.length) console.log('No workflow files found.');
  console.log('\nFollow-ups (owner action — the fleet cannot edit workflow files):');
  for (const f of result.followUps) console.log(`  - ${f}`);
  return 0;
}
