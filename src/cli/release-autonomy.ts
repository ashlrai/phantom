import { auditAutonomy, formatAutonomy } from '../core/release/autonomy-audit.js';

export const RELEASE_AUTONOMY_USAGE = 'Usage: phm release autonomy [--json | --md] [--repo <name>]';
const REPOS = new Set(['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-plugin', 'ashlr-stack', 'ashlr-md']);

/** Inspect release gates without changing GitHub settings or local switches. */
export async function cmdReleaseAutonomy(args: string[], deps: {
  audit?: typeof auditAutonomy;
  emit?: (text: string) => void | Promise<void>;
} = {}): Promise<number> {
  const emit = deps.emit ?? console.log;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    await emit(RELEASE_AUTONOMY_USAGE);
    return 0;
  }
  if (args[0] !== 'autonomy') {
    process.stderr.write(`${RELEASE_AUTONOMY_USAGE}\n`);
    return 2;
  }
  if (args.length === 2 && (args[1] === '--help' || args[1] === '-h')) {
    await emit(RELEASE_AUTONOMY_USAGE);
    return 0;
  }
  let repo: string | undefined;
  let format: 'text' | 'json' | 'md' = 'text';
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--json' || arg === '--md') && format === 'text') {
      format = arg === '--json' ? 'json' : 'md';
    } else if (arg === '--repo' && repo === undefined && args[i + 1] && !args[i + 1].startsWith('-')) {
      repo = args[++i];
    } else {
      process.stderr.write(`${RELEASE_AUTONOMY_USAGE}\n`);
      return 2;
    }
  }
  if (repo !== undefined && !REPOS.has(repo.startsWith('ashlrai/') ? repo.slice('ashlrai/'.length) : repo)) {
    process.stderr.write(`release autonomy: unknown enrolled repository\n${RELEASE_AUTONOMY_USAGE}\n`);
    return 2;
  }
  try {
    const report = await (deps.audit ?? auditAutonomy)({ repo });
    await emit(format === 'json' ? JSON.stringify(report, null, 2) : formatAutonomy(report, format === 'md'));
    return report.complete ? 0 : 1;
  } catch (error) {
    process.stderr.write(`release autonomy: ${error instanceof Error ? error.message : 'audit failed'}\n`);
    return 1;
  }
}
