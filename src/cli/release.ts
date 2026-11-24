import { getReleaseStatus, formatReleaseStatus, getReleases, formatReleases } from '../core/release/status.js';
import { releaseRepoLine } from '../core/release/release-repos.js';
import { releaseStatus, readReleaseState, TRAIN_SCHEMA, type TrainState } from '../core/release/train.js';
import { collectReleaseNotes, formatReleaseNotes, formatReleaseNotesMarkdown, writeReleaseNotes } from '../core/release/notes.js';
import { buildPrNotes, formatPrNotesMarkdown, ghPrSource, resolveRepo, type PrSource } from '../core/release/pr-notes.js';
import { cadenceText, readReleaseCadence, CADENCE_REPOS, type CadenceV1 } from '../core/release/cadence.js';
import { execFileSync } from 'node:child_process';

export const RELEASE_USAGE = 'phm release status [--json | --text] [--file <release-state.json>]\nphm release cadence [--repos <a,b>] [--json]\nphm release notes [--since <tag-or-date>] [--repo <name>] [--json] [--markdown] [--write]';

async function notesCommand(args: string[], prs: PrSource): Promise<number> {
  const json = args.includes('--json');
  let since: string | undefined;
  let repo: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!['--since', '--repo', '--json', '--markdown', '--write'].includes(arg) || seen.has(arg) || ((arg === '--since' || arg === '--repo') && (!args[i + 1] || args[i + 1]!.startsWith('-')))) {
      if (json) emit({ ok: false, reason: RELEASE_USAGE }, true);
      else process.stderr.write(`${RELEASE_USAGE}\n`);
      return 2;
    }
    seen.add(arg);
    if (arg === '--since') since = args[++i];
    if (arg === '--repo') repo = args[++i];
  }
  if (json && seen.has('--markdown')) { emit({ ok: false, reason: RELEASE_USAGE }, true); return 2; }
  if (repo !== undefined && seen.has('--write')) { emit({ ok: false, reason: '--write works on the local clone; drop --repo, or use --markdown to paste' }, json); return 2; }
  try {
    if (repo !== undefined) {
      // Pull-request notes: PR titles and bodies hold the plain words that bridge commit subjects lack.
      if (!since) throw new Error('--repo needs --since <tag>');
      const slug = resolveRepo(repo);
      const notes = buildPrNotes(slug, since, await prs.mergedSince(slug, since));
      if (json) emit(notes, true);
      else process.stdout.write(formatPrNotesMarkdown(notes));
      return 0;
    }
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const notes = collectReleaseNotes(root, since);
    if (seen.has('--write')) writeReleaseNotes(root, notes);
    if (json) emit(notes, true);
    else process.stdout.write(seen.has('--markdown') ? formatReleaseNotesMarkdown(notes) : formatReleaseNotes(notes));
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Cannot generate release notes';
    if (json) emit({ ok: false, reason }, true);
    else process.stderr.write(`Release notes: ${reason}\n`);
    return 1;
  }
}

function emit(payload: unknown, json: boolean): void {
  process.stdout.write(`${JSON.stringify(payload, null, json ? undefined : 2)}\n`);
}

export const RELEASES_USAGE = 'phm releases [--json]';

/** `phm releases`: which Ashlr repo is due a release. Read-only; it never tags or publishes. */
export function cmdReleases(args: string[]): number {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${RELEASES_USAGE}\nShow which Ashlr repo is due a release, from local clones. A repo is due when its latest tag is over 7 days old or over 50 PRs merged since it. Reports only; never tags or publishes.\n`);
    return 0;
  }
  if (args.some(arg => arg !== '--json') || args.length > 1) {
    process.stderr.write(`${RELEASES_USAGE}\n`);
    return 2;
  }
  const report = getReleases();
  if (args.length) emit(report, true);
  else process.stdout.write(formatReleases(report));
  return 0;
}

const CADENCE_HELP = `${RELEASE_USAGE.split('\n')[1]}
How stale is each repo's latest release (${CADENCE_REPOS.join(', ')}), read from public GitHub. Never tags or publishes.
fresh: under 6 hours old, or nothing merged since. due: 6 to 24 hours old with merges since. stale: over 24 hours old with merges since.
has_assets is false for a release with 0 assets. A value that could not be read is "unknown".
--json prints phantom.release-cadence/v1 {schema,as_of,repos:[{repo,latest_tag,published_at,has_assets,hours_since,merged_since,status}]}.`;

/** `phm release cadence`: one read, one table. Exit 0 whatever the verdicts; exit 2 for bad arguments. */
async function cadenceCommand(args: string[], read: () => Promise<CadenceV1> | CadenceV1): Promise<number> {
  const json = args.includes('--json');
  const rest = args.filter(arg => arg !== '--json');
  const flag = rest.indexOf('--repos');
  const list = flag >= 0 ? rest[flag + 1]?.split(',').map(r => r.trim()).filter(Boolean) : undefined;
  if (args.filter(arg => arg === '--json').length > 1 || rest.length !== (flag >= 0 ? 2 : 0) || (flag >= 0 && (!list?.length || list.some(r => !/^[a-z0-9][a-z0-9._-]*$/i.test(r))))) {
    process.stderr.write(`${CADENCE_HELP.split('\n')[0]}\n`);
    return 2;
  }
  const report = await read();
  if (json) emit(report, true);
  else process.stdout.write(`${cadenceText(report).join('\n')}\n`);
  return 0;
}

export async function cmdRelease(args: string[], deps: { prs?: PrSource; cadence?: (repos?: string[]) => Promise<CadenceV1> } = {}): Promise<number> {
  if (args[0] === 'cadence' && (args.includes('--help') || args.includes('-h'))) {
    process.stdout.write(`${CADENCE_HELP}\n`);
    return 0;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${RELEASE_USAGE}\n`);
    return 0;
  }
  if (args[0] === 'cadence') {
    const rest = args.slice(1), flag = rest.indexOf('--repos');
    const repos = flag >= 0 ? rest[flag + 1]?.split(',').map(r => r.trim()).filter(Boolean) : undefined;
    return cadenceCommand(rest, () => (deps.cadence ?? (r => readReleaseCadence({ repos: r })))(repos));
  }
  if (args[0] === 'notes') return notesCommand(args.slice(1), deps.prs ?? ghPrSource);
  const json = !args.includes('--text');
  const rest = args.filter((arg) => arg !== '--json' && arg !== '--text');
  if (rest[0] !== 'status') {
    process.stderr.write(`${RELEASE_USAGE}\n`);
    return 2;
  }
  const fileFlag = rest.indexOf('--file');
  const file = fileFlag >= 0 ? rest[fileFlag + 1] : undefined;
  if ((args.includes('--json') && args.includes('--text')) || (rest.length !== (fileFlag === 1 ? 3 : 1)) || (fileFlag >= 0 && !file)) {
    process.stderr.write(`${RELEASE_USAGE}\n`);
    return 2;
  }
  if (!file) {
    const report = await getReleaseStatus();
    if (json) emit(report, true);
    else process.stdout.write(`${report.releaseRepos.map(row => `${releaseRepoLine(row)}; ${row.state}: ${row.reason}`).join('\n')}\n\n${formatReleaseStatus(report)}\n`);
    return 0;
  }
  try {
    const state: TrainState = readReleaseState(file);
    emit(releaseStatus(state), json);
    return 0;
  } catch {
    emit({ schema: TRAIN_SCHEMA, ok: false, reason: 'release-state-invalid' }, json);
    return 1;
  }
}
