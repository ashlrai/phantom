/** Public docs observations. No execution, model calls, notifications or listeners. */
import { loadRadarSources } from '../core/radar/sources.js';
import { readRadarState, runRadarSource } from '../core/radar/snapshot.js';
import { diffRadarSnapshots } from '../core/radar/diff.js';

const USAGE = `phm radar list [--json]
phm radar run [--json]
phm radar diff [--json]
Public HTTPS GET only. Runs have a six-hour per-source floor, including failed attempts.
Snapshots: ~/.phantom/radar/snapshots/<id>.json. See docs/RADAR.md.`;

export async function cmdRadar(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const emit = (value: unknown): void => console.log(JSON.stringify(value, null, 2));
  const [verb, ...rest] = args.filter(arg => arg !== '--json');
  if (!verb || ['help', '--help', '-h'].includes(verb)) {
    if (json) emit({ usage: USAGE }); else console.log(USAGE);
    return 0;
  }
  if (rest.length || !['list', 'run', 'diff'].includes(verb)) {
    if (json) emit({ ok: false, error: 'Use phm radar list|run|diff --json' }); else console.error(USAGE);
    return 2;
  }
  try {
    const sources = await loadRadarSources();
    if (verb === 'list') {
      if (json) emit({ ok: true, sources });
      else for (const source of sources) console.log(`${source.id}  ${source.kind}  ${source.verified ? 'verified' : 'unverified'}  ${source.url}`);
      return 0;
    }
    const results = [];
    for (const source of sources) {
      try {
        if (verb === 'run') {
          const { state, ...result } = await runRadarSource(source);
          results.push(state?.current ? { ...result, diff: diffRadarSnapshots(state.previous, state.current) } : result);
        } else {
          const state = await readRadarState(source);
          results.push({ id: source.id, status: !state?.current ? 'missing' : state.failed ? 'stale' : 'observed',
            diff: state?.current ? diffRadarSnapshots(state.previous, state.current) : null });
        }
      } catch { results.push({ id: source.id, status: 'error' }); }
    }
    const warnings = results.filter(result => result.status === 'warning').map(result => result.id);
    const ok = results.every(result => !['error', 'busy', 'missing', 'stale', 'unverified'].includes(result.status)) &&
      (verb !== 'run' || warnings.length < results.length);
    if (json) emit(verb === 'run' ? { ok, results, warnings } : { ok, results });
    else for (const result of results) console.log(JSON.stringify(result));
    return ok ? 0 : 1;
  } catch {
    if (json) emit({ ok: false, error: 'Radar catalogue or local state unavailable. See docs/RADAR.md.' });
    else console.error('Radar catalogue or local state unavailable. See docs/RADAR.md.');
    return 1;
  }
}
