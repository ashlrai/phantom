import { readImpactSource, IMPACT_SOURCE_VERSION, type ImpactSourceOptions } from '../core/metrics/impact-source.js';
import { IMPACT_VERSION } from '../core/metrics/impact.js';
import { adviseImpactBandit } from '../core/fabric/optimizer.js';
import { rankJevImpact } from '../core/decide/impact.js';

const HELP = 'Usage: phm metrics impact [--json] [--jobs jobs.jsonl] [--queue graph.json] [--overrides impact-labels.json]\nReads local evidence only; no model calls, network requests, or authority changes.';
interface MetricsDeps { out(line: string): void; err(line: string): void }

export async function runMetricsCli(argv: readonly string[], injected: Partial<MetricsDeps> = {}): Promise<number> {
  const deps: MetricsDeps = {
    out: line => process.stdout.write(`${line}\n`), err: line => process.stderr.write(`${line}\n`), ...injected,
  };
  if (argv.length === 0 || argv.some(a => ['help', '--help', '-h'].includes(a))) { deps.out(HELP); return 0; }
  const [verb, ...args] = argv;
  const options: ImpactSourceOptions = {};
  let json = false;
  const seen = new Set<string>();
  if (verb !== 'impact') { deps.err(HELP); return 2; }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) { deps.err(HELP); return 2; }
    seen.add(arg);
    if (arg === '--json') { json = true; continue; }
    if (!['--jobs', '--queue', '--overrides'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) { deps.err(HELP); return 2; }
    options[arg.slice(2) as keyof ImpactSourceOptions] = args[++i];
  }
  try {
    const source = await readImpactSource(options);
    const jev = rankJevImpact(source.inputs, source.overrides);
    const bandit = adviseImpactBandit(source.inputs, source.overrides);
    const report = {
      version: IMPACT_VERSION, sourceVersion: IMPACT_SOURCE_VERSION,
      advisory: true, complete: source.complete, warnings: source.warnings,
      totalReward: source.complete ? jev.outcomes.reduce((total, result) => total + result.reward, 0) : null,
      outcomes: jev.outcomes, templates: bandit.ranking, bandit, jev,
    };
    if (json) deps.out(JSON.stringify(report, null, 2));
    else {
      deps.out(`Impact ${report.version}: ${report.outcomes.length} outcomes, reward ${report.totalReward === null ? 'unknown' : report.totalReward.toFixed(6)}`);
      for (const warning of report.warnings) deps.out(warning);
      for (const outcome of report.outcomes) deps.out(`${outcome.id}: ${outcome.reward.toFixed(6)} (${outcome.status})`);
      if (bandit.recommendation) deps.out(`Advisory template: ${bandit.recommendation.template}`);
    }
    return 0;
  } catch (error) {
    const detail = error instanceof Error && /^(Invalid impact |Cannot read impact )/.test(error.message) ? ` ${error.message}` : '';
    deps.err(`Impact evidence could not be read or validated.${detail} Check the documented source schema and references.`);
    return 1;
  }
}
