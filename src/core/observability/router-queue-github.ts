/** Read-only GitHub evidence, pinned to the publication's exact repository/PR/head. */
import {
  object, parseStationEvent, positiveInteger, publicationReceipt, sha, stationEvent, timestamp,
  type PublicationReceipt, type StationEvent,
} from './router-queue.js';

export type QueueGh = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;
export interface QueuePollResult { events: StationEvent[]; unavailable: string[] }
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FAILURE = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
const SUCCESS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'REQUESTED', 'WAITING']);
function githubDate(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) {
    throw new Error('GitHub date unavailable');
  }
  timestamp(value.includes('.') ? value : value.replace('Z', '.000Z'));
}

async function read(gh: QueueGh, args: string[]): Promise<unknown> {
  const result = await gh(args);
  if (!result.ok || Buffer.byteLength(result.stdout) > MAX_RESPONSE_BYTES) throw new Error('GitHub observation unavailable');
  const value: unknown = JSON.parse(result.stdout);
  if (value && typeof value === 'object' && 'errors' in value) throw new Error('Partial GitHub observation');
  return value;
}
function ciState(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const states: string[] = [];
  for (const check of value) {
    const row = object(check);
    const state = row['status'] !== undefined && row['status'] !== 'COMPLETED' ? row['status'] : row['conclusion'] ?? row['state'];
    if (typeof state !== 'string' || (!FAILURE.has(state) && !SUCCESS.has(state) && !PENDING.has(state))) return null;
    states.push(state);
  }
  return states.some(state => FAILURE.has(state)) ? 'failure' : states.some(state => PENDING.has(state)) ? 'pending' : 'success';
}

/** No retry/backoff loop here: the box scheduler invokes one bounded poll at a time.
 * Partial/API errors are explicit unknowns and never synthesize station evidence. */
export async function pollQueueGithub(receipt: PublicationReceipt, gh: QueueGh, observedAt: string): Promise<QueuePollResult> {
  const publication = publicationReceipt(receipt); timestamp(observedAt);
  const { repo, pr, headSha } = publication;
  const events: StationEvent[] = []; const unavailable: string[] = [];
  const emit = (station: StationEvent['station'], evidence: StationEvent['evidence']) => {
    events.push(parseStationEvent(stationEvent(publication, station, observedAt, 'github', evidence)));
  };
  let pull: Record<string, unknown>;
  try {
    pull = object(await read(gh, ['pr', 'view', String(pr), '--repo', repo, '--json',
      'number,url,state,headRefOid,baseRefName,isCrossRepository,headRepository,headRepositoryOwner,mergeCommit,statusCheckRollup']));
    const remoteRepo = `${object(pull['headRepositoryOwner'])['login']}/${object(pull['headRepository'])['name']}`.toLowerCase();
    if (pull['number'] !== pr || typeof pull['url'] !== 'string' || pull['url'].toLowerCase() !== `https://github.com/${repo}/pull/${pr}` || pull['headRefOid'] !== headSha
      || pull['isCrossRepository'] !== false || remoteRepo !== repo || !['OPEN', 'MERGED', 'CLOSED'].includes(String(pull['state']))) {
      return { events, unavailable: ['pr-identity-mismatch'] };
    }
  } catch { return { events, unavailable: ['pr-unavailable'] }; }
  try {
    const ci = ciState(pull['statusCheckRollup']);
    if (ci) emit('pr-ci', { pr, headSha, ci });
    else unavailable.push('pr-ci-unavailable');
  } catch { unavailable.push('pr-ci-unavailable'); }

  if (pull['state'] === 'OPEN') {
    try {
      const [owner, name] = repo.split('/');
      // autoMergeRequest is intent, not proof of an actual merge-queue entry.
      const response = object(await read(gh, ['api', 'graphql', '-f',
        'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid mergeQueueEntry{id}}}}',
        '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`]));
      const queued = object(object(object(response['data'])['repository'])['pullRequest']);
      if (queued['headRefOid'] !== headSha) throw new Error('Queue head changed');
      if (queued['mergeQueueEntry'] !== null) {
        const entryId = object(queued['mergeQueueEntry'])['id'];
        if (typeof entryId !== 'string') throw new Error('Queue entry unavailable');
        emit('merge-queue', { pr, headSha, entryId });
      }
    } catch { unavailable.push('merge-queue-unavailable'); }
    return { events, unavailable };
  }
  if (pull['state'] !== 'MERGED') return { events, unavailable };
  let mergeSha: string;
  try { mergeSha = sha(object(pull['mergeCommit'])['oid']); emit('merged', { pr, headSha, mergeSha }); }
  catch { return { events, unavailable: [...unavailable, 'merge-commit-unavailable'] }; }

  try {
    const releases = await read(gh, ['api', `repos/${repo}/releases?per_page=20`]);
    if (!Array.isArray(releases) || releases.length > 20) throw new Error('Release list unavailable');
    // Inspect at most the five latest stable candidates, newest first as returned by GitHub.
    let compared = 0; let found = false;
    for (const candidate of releases) {
      const release = object(candidate);
      const releaseId = positiveInteger(release['id']); const tag = release['tag_name'];
      if (typeof tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/.test(tag)) throw new Error('Release tag unavailable');
      if (typeof release['draft'] !== 'boolean' || typeof release['prerelease'] !== 'boolean') throw new Error('Release flags unavailable');
      if (release['published_at'] !== null) githubDate(release['published_at']);
      if (release['draft'] || release['prerelease'] || release['published_at'] === null) continue;
      const comparison = object(await read(gh, ['api', `repos/${repo}/compare/${mergeSha}...${encodeURIComponent(tag)}`]));
      if (['ahead', 'identical'].includes(String(comparison['status'])) && object(comparison['merge_base_commit'])['sha'] === mergeSha) {
        emit('released', { pr, mergeSha, releaseId, tag }); found = true; break;
      }
      if (++compared === 5) break;
    }
    if (!found && (releases.length === 20 || compared === 5)) unavailable.push('release-search-bounded');
  } catch { unavailable.push('release-unavailable'); }

  try {
    const branch = pull['baseRefName'];
    if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)) throw new Error('Base branch unavailable');
    const repository = object(await read(gh, ['api', `repos/${repo}`]));
    if (typeof repository['full_name'] !== 'string' || repository['full_name'].toLowerCase() !== repo
      || typeof repository['default_branch'] !== 'string') throw new Error('Repository identity unavailable');
    if (branch !== repository['default_branch']) return { events, unavailable };
    const runs = await read(gh, ['run', 'list', '--repo', repo, '--branch', branch, '--commit', mergeSha, '--event', 'push',
      '--limit', '100', '--json', 'databaseId,headSha,headBranch,event,status,conclusion']);
    if (!Array.isArray(runs) || runs.length > 100) throw new Error('Main CI unavailable');
    for (const value of runs) {
      const run = object(value);
      sha(run['headSha']); positiveInteger(run['databaseId']);
      if (typeof run['headBranch'] !== 'string' || typeof run['event'] !== 'string'
        || typeof run['status'] !== 'string' || !['completed', 'queued', 'in_progress', 'requested', 'waiting', 'pending'].includes(run['status'])
        || (run['status'] === 'completed' && (typeof run['conclusion'] !== 'string'
          || ![...FAILURE, ...SUCCESS].includes(run['conclusion'].toUpperCase())))) throw new Error('Main CI row unavailable');
      if (run['headSha'] !== mergeSha || run['headBranch'] !== branch || run['event'] !== 'push' || run['status'] !== 'completed') continue;
      if (run['conclusion'] === 'failure' || run['conclusion'] === 'timed_out' || run['conclusion'] === 'startup_failure') {
        emit('fix-main', { pr, mergeSha, runId: positiveInteger(run['databaseId']) });
      }
    }
    if (runs.length === 100) unavailable.push('main-ci-search-bounded');
  } catch { unavailable.push('main-ci-unavailable'); }
  return { events, unavailable };
}
