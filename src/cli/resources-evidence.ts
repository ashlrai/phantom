import { isAbsolute } from 'node:path';
import { recordResetEvidence } from '../core/usage/resource-live/evidence-collector.js';
import { defaultResourceLiveRunsDir } from '../core/usage/resource-live/feed.js';

const usage = 'Usage: phm resources evidence record --resource codex-personal --resets N [--expires ISO,ISO] --source owner-screenshot [--observed-at ISO] [--kind full|5h|weekly] [--runs-dir ABSOLUTE] [--json]';

export async function cmdResourcesEvidence(args: string[], now = Date.now()): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const fail = () => { console.error(usage); return 2; };
  if (args[0] !== 'record') return fail();
  const values = new Map<string, string>();
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (values.has(flag) || !['--resource', '--resets', '--expires', '--source', '--kind', '--observed-at', '--runs-dir'].includes(flag)) return fail();
    const value = args[++i];
    if (!value || value.startsWith('--')) return fail();
    values.set(flag, value);
  }
  const count = values.get('--resets') ?? '', kind = values.get('--kind') ?? 'full';
  const expires = values.get('--expires')?.split(',') ?? [];
  const runsDir = values.get('--runs-dir') ?? defaultResourceLiveRunsDir();
  if (values.get('--resource') !== 'codex-personal' || values.get('--source') !== 'owner-screenshot' ||
    !/^(0|[1-9][0-9]{0,2})$/.test(count) || Number(count) !== expires.length ||
    (kind !== 'full' && kind !== '5h' && kind !== 'weekly') || !isAbsolute(runsDir)) return fail();
  try {
    const bank = await recordResetEvidence(runsDir, Number(count), expires, kind, values.get('--observed-at') ?? new Date(now).toISOString(), now);
    console.log(json ? JSON.stringify(bank) : `Recorded ${bank.count} Codex reset grants. No reset was used.`);
    return 0;
  } catch {
    console.error('resources evidence: could not record reset evidence; check dates, freshness and local evidence storage');
    return 2;
  }
}
