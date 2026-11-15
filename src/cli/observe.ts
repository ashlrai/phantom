/**
 * `phm observe` prints the human observe snapshot. Read-only.
 */
import { parsePullExport } from '../core/observe/pulls.js';
import { readJsonFile, readObserveSession, readObserveSnapshot } from '../core/observe/read.js';

const USAGE = `phm observe [--json] [--human-steps <file>] [--bottlenecks <file>] [--prs <file>] [--days <n>] [--claim-minutes <n>]
phm observe session <id> [--json]

One observe.human.v1 snapshot. Unknown measurements stay unknown.
See docs/OBSERVE.md.`;

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith('-') ? value : null;
}

function positive(value: string | null, fallback: number, max: number): number | null {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}

export async function cmdObserve(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const emit = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (args.includes('--help') || args.includes('-h') || args.length === 0 && !json) {
    if (args.length === 0 && !json) { console.log(USAGE); return 0; }
    if (args.includes('--help') || args.includes('-h')) {
      if (json) emit({ usage: USAGE }); else console.log(USAGE);
      return 0;
    }
  }
  const rest = args.filter((arg) => arg !== '--json');
  const allowed = new Set(['--human-steps', '--bottlenecks', '--prs', '--days', '--claim-minutes']);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith('-')) continue;
    const value = rest[index + 1];
    if (!allowed.has(arg) || !value || value.startsWith('-')) {
      if (json) emit({ ok: false, error: 'Unknown observe flag' }); else console.error(USAGE);
      return 2;
    }
    index += 1;
  }
  const session = rest[0] === 'session';
  if (session) {
    const id = rest[1];
    if (!id || rest.length > 2) {
      if (json) emit({ ok: false, error: 'Use phm observe session <id> --json' }); else console.error(USAGE);
      return 2;
    }
    const detail = await readObserveSession(id);
    if (json) emit(detail);
    else console.log(`${detail.sessionId}: ${detail.state}${detail.reason ? ` (${detail.reason})` : ''}`);
    return 0;
  }
  if (rest.some((arg) => arg.startsWith('-') && !['--human-steps', '--bottlenecks', '--prs', '--days', '--claim-minutes'].includes(arg) && !rest.includes(arg))) {
    if (json) emit({ ok: false, error: 'Unknown observe flag' }); else console.error(USAGE);
    return 2;
  }
  const days = positive(flag(rest, '--days'), 7, 90);
  const minutes = positive(flag(rest, '--claim-minutes'), 15, 180);
  if (days === null || minutes === null) {
    if (json) emit({ ok: false, error: 'days and claim-minutes must be whole numbers in range' }); else console.error(USAGE);
    return 2;
  }
  const pullsFile = flag(rest, '--prs');
  const parsed = pullsFile ? parsePullExport(await readJsonFile(pullsFile)) : null;
  if (pullsFile && !parsed) {
    if (json) emit({ ok: false, error: 'Pull export could not be read' }); else console.error('Pull export could not be read');
    return 1;
  }
  const snapshot = await readObserveSnapshot({
    humanStepsFile: flag(rest, '--human-steps'),
    bottlenecksFile: flag(rest, '--bottlenecks'),
    pulls: parsed?.pulls,
    pullsComplete: parsed?.complete,
    windowDays: days,
    windowMs: minutes * 60_000,
  });
  if (json) emit(snapshot);
  else {
    const counts = snapshot.resources.counts;
    const show = (value: number | null) => value === null ? 'unknown' : String(value);
    console.log(`Resources: ${show(counts.coordinated)} coordinated, ${show(counts.idle)} idle, ${show(counts.duplicated)} duplicated, ${show(counts.unknown)} unknown`);
    console.log(`Human steps remaining: ${snapshot.humans.stepsRemaining === null ? 'unknown' : snapshot.humans.stepsRemaining}`);
    console.log(`Bottlenecks: ${snapshot.bottlenecks.top.length === 0 ? 'unknown' : snapshot.bottlenecks.top.map((item) => item.id).join(', ')}`);
    console.log(`Fields live ${snapshot.coverage.fields.live}, unknown ${snapshot.coverage.fields.unknown}`);
  }
  return 0;
}
