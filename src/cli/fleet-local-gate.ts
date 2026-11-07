import { runLocalGate, type LocalGateDeps } from '../core/fleet/local-gate.js';

const usage = 'Usage: ashlr fleet local-gate [--json] [--budget-seconds <n>]';

export async function cmdFleetLocalGate(args: string[], deps: LocalGateDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); return 0; }
  let json = false;
  let budget = 180;
  let hasBudget = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--budget-seconds' && !hasBudget && args[i + 1] !== undefined) {
      hasBudget = true;
      budget = Number(args[++i]);
      if (!Number.isFinite(budget) || budget <= 0) { process.stderr.write(usage + '\n'); return 2; }
    } else { process.stderr.write(usage + '\n'); return 2; }
  }
  const report = await runLocalGate(budget, deps);
  console.log(json ? JSON.stringify(report) : [
    ...report.steps.map(step => `${step.ok ? 'PASS' : 'FAIL'} ${step.name} (${step.seconds.toFixed(2)}s)`),
    `${report.verdict.toUpperCase()} total (${report.seconds.toFixed(2)}s)`,
  ].join('\n'));
  return report.verdict === 'pass' ? 0 : 1;
}
