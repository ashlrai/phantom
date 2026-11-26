import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { regular } from './consumer-install.js';

const capability = 'phantom.desktop-update-interlock.v1';
const dispatcherReconciliation = 'phantom.desktop-update-dispatch-reconcile.v1';
const components = ['launch.sh', 'batch-launch.sh', 'local_job.py', 'release-autorun.sh',
  'dispatchd.py', 'desktop_update_interlock.py'] as const;

export type DesktopHostInterlockCensus =
  | { state: 'absent'; activeJobs: 0; unknown: 0 }
  | { state: 'unsupported'; activeJobs: 0; unknown: 1 }
  | { state: 'supported'; activeJobs: number; unknown: number };

const sources = {
  'desktop_update_interlock.py': 'ebac2917a4bc10ba9cbfe7b8754b53239eb8b4d2184f58ee2df24ed947dd690b',
  'process_snapshot.py': 'bf1b46fdf6e766a7e310ab92a1ef3521350888a5504c389385246e80e16a68a1',
};
type CensusRunner = (home: string, probe: string, processSnapshot: string, timeoutMs: number) => unknown;
const runCensus: CensusRunner = (home, probe, processSnapshot, timeoutMs) => {
  const driver = `import json,os,sys
probe_source,snapshot_source=json.load(sys.stdin)
probe,snapshot={},{}
exec(compile(snapshot_source,'<snapshot>','exec'),snapshot)
exec(compile(probe_source,'<census>','exec'),probe)
home=sys.argv[1]
print(json.dumps(probe['census'](home,os.path.join(home,'.ashlr-runs','queue'),snapshot['capture'])))`;
  const child = spawnSync('/usr/bin/python3', ['-IB', '-c', driver, home], {
    input: JSON.stringify([probe, processSnapshot]),
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16_384,
    cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
  });
  return child.status === 0 ? JSON.parse(child.stdout) as unknown : null;
};

export function readDesktopHostInterlockCensus(home: string, run: CensusRunner = runCensus, timeoutMs = 5_000): DesktopHostInterlockCensus {
  const unsupported = { state: 'unsupported', activeJobs: 0, unknown: 1 } as const;
  const root = join(home, '.ashlr-runs');
  const bin = join(root, 'bin');
  const verifiedSources: string[] = [];
  try {
    const uid = process.getuid?.();
    if (uid === undefined) return unsupported;
    const host = lstatSync(root, { throwIfNoEntry: false });
    if (!host) return { state: 'absent', activeJobs: 0, unknown: 0 };
    for (const dir of [lstatSync(home), host, lstatSync(bin)]) {
      if (!dir.isDirectory() || dir.uid !== uid || dir.mode & 0o022) return unsupported;
    }
    for (const name of components) {
      const { data, identity } = regular(join(bin, name), 2 * 1024 * 1024);
      const lines = data.toString('utf8').split('\n');
      if (identity.uid !== uid || !lines.includes(`# ${capability}`) ||
          (name === 'dispatchd.py' && !lines.includes(`# ${dispatcherReconciliation}`))) return unsupported;
    }
    for (const [name, sha] of Object.entries(sources)) {
      const { data, identity } = regular(join(bin, name), 128 * 1024);
      if (identity.uid !== uid || createHash('sha256').update(data).digest('hex') !== sha) return unsupported;
      verifiedSources.push(data.toString('utf8'));
    }
  } catch {
    return unsupported;
  }
  try {
    const result = run(home, verifiedSources[0]!, verifiedSources[1]!, Math.min(5_000, Math.max(1, Math.floor(timeoutMs)))) as
      {schema?: unknown; activeJobs?: unknown; unknown?: unknown} | null;
    if (result?.schema === capability && typeof result.activeJobs === 'number' &&
        Number.isSafeInteger(result.activeJobs) && result.activeJobs >= 0 && (result.unknown === 0 || result.unknown === 1)) {
      return { state: 'supported', activeJobs: result.activeJobs, unknown: result.unknown };
    }
  } catch {
    // Unreadable census is not proof of quiescence.
  }
  return { state: 'supported', activeJobs: 0, unknown: 1 };
}
