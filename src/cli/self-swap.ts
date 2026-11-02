import { applySelfSwap, planSelfSwap, type SelfSwapOptions } from '../core/daemon/self-swap.js';
import { selfSwapRuntime } from '../core/daemon/self-swap-runtime.js';

const USAGE = 'phm self-swap --root <install-dir> --next <version> --old-pid <pid> [--spare-port <port>] [--plan | --apply --supervised] [--json]';

/** Explicit apply only; both the default and errors are machine-readable. */
export async function cmdSelfSwap(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (values.has(key) || flags.has(key)) { console.log(JSON.stringify({ error: 'Duplicate option' })); return 2; }
    if (['--plan', '--apply', '--supervised', '--json'].includes(key)) flags.add(key);
    else if (['--root', '--next', '--old-pid', '--spare-port'].includes(key) && args[i + 1] && !args[i + 1]!.startsWith('--')) values.set(key, args[++i]!);
    else { console.log(JSON.stringify({ error: 'Unknown option or missing value', usage: USAGE })); return 2; }
  }
  const apply = flags.has('--apply');
  if ((apply && flags.has('--plan')) || (apply && !flags.has('--supervised'))) {
    console.log(JSON.stringify({ error: '--apply requires --supervised and excludes --plan', usage: USAGE })); return 2;
  }
  const missing = ['--root', '--next', '--old-pid'].filter(key => !values.has(key));
  if (missing.length) {
    console.log(JSON.stringify({ mode: 'plan', executable: false, missing, usage: USAGE,
      prerequisite: 'Supervisor must restart the old process through current. Candidate sources and dependencies must already exist under versions/<version>.' }));
    return apply ? 2 : 0;
  }
  const options: SelfSwapOptions = { root: values.get('--root')!, next: values.get('--next')!, oldPid: Number(values.get('--old-pid')), sparePort: Number(values.get('--spare-port') ?? 0) };
  try {
    console.log(JSON.stringify(apply ? await applySelfSwap(options, selfSwapRuntime) : planSelfSwap(options)));
    return 0;
  } catch {
    // Errors from builds, paths and platform probes may contain sensitive data.
    console.log(JSON.stringify({ error: 'Self-swap failed; inspect installation and retry apply for journal recovery. The old process is never force-killed.' }));
    return 1;
  }
}
