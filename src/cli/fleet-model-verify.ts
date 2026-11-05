import { verifyFleetModels, type ModelVerifyOptions, type ModelVerifyReport } from '../core/fleet/model-verify.js';

const USAGE = 'Usage: phm fleet model-verify [--json]\n'
  + 'Check models.json under ASHLR_RUNS_DIR (default ~/.ashlr-runs) against docs/model-registry.json.\n'
  + 'List unknown IDs and entries verified more than 30 days ago. haiku, sonnet, opus, auto, fast, strong pass.\n'
  + 'Exit 0: clean; 1: findings or unreadable/invalid sources; 2: bad usage. Offline; no account access check.\n'
  + 'To refresh evidence, confirm the exact ID in official provider docs, then update its verified date.';

export async function cmdFleetModelVerify(args: string[], opts: ModelVerifyOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  if (args.length > 1 || args.some(arg => arg !== '--json')) { console.error(USAGE); return 2; }
  let report: ModelVerifyReport;
  try { report = await verifyFleetModels(opts); }
  // Never echo parser errors: they can contain arbitrary input file contents.
  catch { report = { schema: 'fleet.model-verify.v1', issues: [], error: 'Cannot read or validate models.json or docs/model-registry.json.' }; }
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else if (report.error) console.error(report.error);
  else if (!report.issues.length) console.log('All model IDs have current documentation or are allowed aliases.');
  else for (const issue of report.issues) console.log(`${JSON.stringify(issue.key)}: ${JSON.stringify(issue.model)} — ${issue.reason}`);
  return report.error || report.issues.length ? 1 : 0;
}
