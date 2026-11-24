/**
 * `phm needs-you`: the short list of what truly waits on Mason, and one verb
 * that lets the fleet clear everything else. Thin: logic in core/needs-you.
 */
import {
  batchNeedsYou, listNeedsYou, readNeedsYouAudit, resolveAutoNeedsYou, type NeedsYouOptions,
} from '../core/needs-you/index.js';

export const NEEDS_YOU_USAGE = `Usage: phm needs-you [--json] [--runs-dir DIR]
       phm needs-you resolve --auto [--dry-run] [--json] [--runs-dir DIR]
       phm needs-you batch [--json] [--runs-dir DIR]
       phm needs-you log [--json] [--runs-dir DIR]
  Lists open items with their class: hard_limit (secrets, money, a send outside
  the team, deleting data, or a password/2FA/device approval) waits on you;
  auto is ordinary work. resolve --auto takes each auto item's forward action
  and writes an audit record; --dry-run shows the same records and changes
  nothing. batch puts every item that needs you into one message with a
  one-word reply each. log lists the audit records.`;

export interface NeedsYouCliDeps extends Pick<NeedsYouOptions, 'now' | 'resolve' | 'bus'> {
  output?: (text: string) => void;
  error?: (text: string) => void;
}

export async function cmdNeedsYou(args: string[], deps: NeedsYouCliDeps = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => { process.stderr.write(`${text}\n`); });
  if (args.some(arg => arg === '--help' || arg === '-h')) { output(NEEDS_YOU_USAGE); return 0; }
  const verb = args[0] === 'resolve' || args[0] === 'log' || args[0] === 'batch' ? args[0] : 'list';
  const flags = new Set<string>();
  let runsDir: string | undefined;
  for (let i = verb === 'list' ? 0 : 1; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('-')) { runsDir = next; i++; continue; }
    const allowed = verb === 'resolve' ? ['--json', '--auto', '--dry-run'] : ['--json'];
    if (!allowed.includes(arg) || flags.has(arg)) { error(NEEDS_YOU_USAGE); return 2; }
    flags.add(arg);
  }
  const json = flags.has('--json');
  const options: NeedsYouOptions = { runsDir, now: deps.now, resolve: deps.resolve, bus: deps.bus };

  if (verb === 'resolve') {
    if (!flags.has('--auto')) { error('Say --auto: only auto items resolve without you.'); return 2; }
    const report = resolveAutoNeedsYou({ ...options, dryRun: flags.has('--dry-run') });
    if (json) output(JSON.stringify(report));
    else if (report.ledger === 'unavailable') error('The needs-you list could not be read.');
    else output([
      ...report.resolved.map(r => `${report.dryRun ? 'would' : 'done'}: ${r.action} — ${r.item.title}`),
      ...report.failed.map(f => `failed: ${f.id} — ${f.error}`),
      `${report.resolved.length} ${report.dryRun ? 'would resolve' : 'resolved'}, ${report.failed.length} failed, ${report.hardLimit} still need you.`,
    ].join('\n'));
    return report.ledger === 'unavailable' || report.failed.length ? 1 : 0;
  }

  if (verb === 'batch') {
    const batch = batchNeedsYou(options);
    if (json) output(JSON.stringify(batch));
    else if (batch.ledger === 'unavailable') error('The needs-you list could not be read.');
    else output(batch.message || 'Nothing needs you.');
    return batch.ledger === 'unavailable' ? 1 : 0;
  }

  if (verb === 'log') {
    const records = readNeedsYouAudit(options);
    if (json) output(JSON.stringify({ schema: 'phantom.needs-you.log.v1', count: records.length, records }));
    else output(records.length ? records.map(r => `${r.at}  ${r.action} — ${r.item.title}`).join('\n') : 'Nothing resolved automatically yet.');
    return 0;
  }

  const list = listNeedsYou(options);
  if (json) { output(JSON.stringify(list)); return list.ledger === 'unavailable' ? 1 : 0; }
  if (list.ledger === 'unavailable') { error('The needs-you list could not be read.'); return 1; }
  const lines = list.hardLimit.length
    ? [`${list.hardLimit.length} need you:`, ...list.hardLimit.map((item, n) =>
      `  ${n + 1}. ${item.title} (${item.reason}) — ${item.answers.join(' / ')}: ${item.answer}`)]
    : ['Nothing needs you.'];
  if (list.auto.length) lines.push(`${list.auto.length} the fleet can handle: phm needs-you resolve --auto`);
  output(lines.join('\n'));
  return 0;
}
