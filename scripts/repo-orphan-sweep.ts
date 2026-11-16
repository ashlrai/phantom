import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readOwnerInput, sweepRepoOrphans } from '../src/core/fleet/repo-owners.js';

export function runRepoOrphanSweep(args: readonly string[], write = (line: string) => process.stdout.write(`${line}\n`)): number {
  try {
    const values = new Map<string, string>();
    let apply = false, registerOnly = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--apply' && !apply) apply = true;
      else if (arg === '--register-only' && !registerOnly) registerOnly = true;
      else if (['--prs', '--ready', '--owners', '--root'].includes(arg) && !values.has(arg)) {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error('invalid-arguments');
        values.set(arg, resolve(value));
      } else throw new Error('invalid-arguments');
    }
    if (!registerOnly && (!values.has('--prs') || !values.has('--ready'))) throw new Error('missing-inputs');
    const registry = values.get('--owners') ?? fileURLToPath(new URL('../fleet/repo-owners.json', import.meta.url));
    const report = sweepRepoOrphans({ registry: JSON.parse(readOwnerInput(registry)),
      prs: values.has('--prs') ? JSON.parse(readOwnerInput(values.get('--prs')!)) :
        { version: 1, complete: false, observedAt: Date.now(), prs: [], leases: [] },
      ready: values.has('--ready') ? readOwnerInput(values.get('--ready')!) : '',
      root: values.get('--root'), apply, registerOnly });
    write(JSON.stringify(report));
    return report.status === 'partial' || report.rows.some(row => row.disposition === 'failed') ||
      report.registrations.some(row => !['posted', 'duplicate'].includes(row.status)) ? 1 : 0;
  } catch (error) {
    const known = ['sweep-lease-unavailable', 'kill-switch', 'input-unavailable', 'leases-unavailable',
      'registry-unavailable', 'owner-registry-conflict', 'bus-unavailable', 'bus-churn',
      'incomplete-or-stale-pr-snapshot', 'conflicting-item', 'conflicting-bus-owners',
      'invalid-ready-row', 'invalid-ready-repo', 'missing-inputs', 'invalid-arguments'];
    write(JSON.stringify({ schema: 'fleet.repo-owners.v1', status: 'blocked',
      reason: error instanceof Error && known.includes(error.message) ? error.message : 'invalid-ownership-evidence', assigned: 0 }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runRepoOrphanSweep(process.argv.slice(2));
}
