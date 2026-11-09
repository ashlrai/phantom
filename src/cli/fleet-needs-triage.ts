import { readNeedsMason, resolveNeedsMason, type NeedsMasonOptions } from '../core/fleet/needs-mason-resolve.js';
import { triageNeedsItems } from '../core/fleet/needs-mason-triage.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet needs-triage [--apply] [--json] [--runs-dir DIR]';

export async function cmdFleetNeedsTriage(args: string[], deps: {
  read?: typeof readNeedsMason; resolve?: typeof resolveNeedsMason; bus?: NeedsMasonOptions['bus'];
  /** Capture seams so self-tick can fold the report; default to the console. */
  output?: (text: string) => void; error?: (text: string) => void;
} = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => { process.stderr.write(`${text}\n`); });
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { output(usage); return 0; }
  let json = false, apply = false, runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('-')) { runsDir = next; i++; }
    else { error(usage); return 2; }
  }
  const read = (deps.read ?? readNeedsMason)({ runsDir });
  if (read.status === 'unavailable') {
    if (json) output(JSON.stringify({ v: 1, auto: [], hardLimit: [], applied: false, status: 'unavailable' }));
    else error('error: fleet needs unavailable');
    return 1;
  }
  const { auto, hardLimit } = triageNeedsItems(read.items);
  const counts = { ok: 0, duplicate: 0, failed: 0 };
  if (apply) for (const item of auto) {
    try {
      const result = (deps.resolve ?? resolveNeedsMason)({ itemId: item.id, reply: 'auto-resolved: outside the four hard limits (t1637u)' }, { runsDir, bus: deps.bus, source: 'leader' });
      if (result.ok) counts[result.duplicate ? 'duplicate' : 'ok']++;
      else if (result.code === 'already-resolved') counts.duplicate++;
      else counts.failed++;
    } catch { counts.failed++; }
  }
  if (json) output(scrubSecrets(JSON.stringify({ v: 1, auto, hardLimit, applied: apply, ...(apply ? { counts } : {}) })));
  else output(scrubSecrets([
    `${auto.length} auto-resolvable, ${hardLimit.length} need Mason`,
    ...auto.map(item => `${item.id}  auto: ${item.text} — outside the four hard limits`),
    ...hardLimit.map(item => `${item.id}  hard-limit (${item.limit}): ${item.text} — ${item.reason}`),
    ...(apply ? [`${counts.ok} ok, ${counts.duplicate} duplicate, ${counts.failed} failed`] : []),
  ].join('\n')));
  return counts.failed ? 1 : 0;
}
