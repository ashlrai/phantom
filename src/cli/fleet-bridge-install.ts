import { installBridge, type BridgeInstallDeps } from '../core/fleet/bridge-install.js';

export async function cmdFleetBridgeInstall(args: string[], deps: BridgeInstallDeps = {}): Promise<number> {
  const usage = 'Usage: ashlr fleet bridge-install [--root <dir>] [--apply] [--json]';
  const badArguments = () => {
    if (args.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, root: null, releaseId: null, applied: false, unchanged: false, started: false, files: [], error: usage }));
    else console.error(`${usage}\nNothing was started.`);
    return 2;
  };
  const seen = new Set<string>();
  let root: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (seen.has(arg) || !['--root', '--apply', '--json'].includes(arg)) {
      return badArguments();
    }
    seen.add(arg);
    if (arg === '--root') {
      root = args[++i];
      if (!root || root.startsWith('--')) { return badArguments(); }
    }
  }
  try {
    const result = await installBridge({ root, apply: seen.has('--apply') }, deps);
    if (seen.has('--json')) console.log(JSON.stringify(result));
    else console.log([
      `${result.files.filter(file => file.status !== 'removed').length} files; release ${result.releaseId}; ${result.unchanged ? 'unchanged' : result.applied ? 'applied' : 'preview'}`,
      ...result.files.map(file => `${file.name}: ${file.status}`), 'Nothing was started.',
    ].join('\n'));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (seen.has('--json')) console.log(JSON.stringify({ schemaVersion: 1, root: root ?? null, releaseId: null, applied: false, unchanged: false, started: false, files: [], error: message }));
    else console.error(`${message}\nNothing was started.`);
    return 1;
  }
}
