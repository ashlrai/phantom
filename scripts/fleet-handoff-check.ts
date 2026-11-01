import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFleetJobDetail, isFleetJobId } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

type Readers = {
  detail: typeof getFleetJobDetail;
  text: typeof getFleetJobText;
};

type PullRef = { repo: string; number: string; url: string };
const repoPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;

// Return canonical references only; never return a URL's query, fragment or user info.
function pullRef(value: string): PullRef | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return null;
    const match = /^\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:\/[^\s]*)?$/i.exec(url.pathname);
    if (!match) return null;
    const repo = `${match[1]}/${match[2]}`.toLowerCase();
    return { repo, number: match[3]!, url: `https://github.com/${repo}/pull/${match[3]}` };
  } catch {
    return null;
  }
}

function references(text: string): PullRef[] {
  const refs = new Map<string, PullRef>();
  // Starting at a URL boundary prevents an embedded github.com in a different URL
  // from becoming evidence. Markdown closing punctuation is not part of a URL.
  for (const match of text.matchAll(/(?:^|[\s(<[])(https:\/\/[^\s<>"'`]+)/gim)) {
    const ref = pullRef(match[1]!.replace(/[),.;!\]}]+$/, ''));
    if (ref) refs.set(ref.url, ref);
  }
  return [...refs.values()];
}

/** Inspect retained artifacts only. A match is consistency evidence, not truth. */
export async function checkFleetHandoff(job: string, repo: string, readers: Readers = {
  detail: getFleetJobDetail, text: getFleetJobText,
}) {
  if (!isFleetJobId(job) || !repoPattern.test(repo) || /[\r\n]/.test(repo)) throw new Error('invalid arguments');
  repo = repo.toLowerCase();
  const [detail, notes] = await Promise.all([readers.detail(job), readers.text(job, 'notes')]);
  const publication = detail.publish?.prUrl ? pullRef(detail.publish.prUrl) : null;
  const published = detail.state === 'published' && detail.sources.publish === 'healthy'
    && Boolean(publication && publication.repo === repo && detail.publish?.testLine?.trim());
  const notesReady = notes.state === 'ok' && !notes.truncated && Boolean(notes.text.trim());
  const refs = notes.state === 'ok' ? references(notes.text) : [];
  const sameRepo = refs.filter(ref => ref.repo === repo);
  const otherRepos = refs.filter(ref => ref.repo !== repo);
  let verdict: 'matched' | 'no-explicit-reference' | 'mismatch' | 'unavailable' = 'unavailable';
  if (published && notesReady && publication) {
    verdict = sameRepo.some(ref => ref.number !== publication.number) ? 'mismatch'
      : sameRepo.length ? 'matched' : 'no-explicit-reference';
  }
  return {
    schema: 'fleet.handoff-check.v1', job, repo, verdict, complete: verdict === 'matched',
    publication: { state: detail.state, source: detail.sources.publish, healthy: published,
      ref: publication, hasTestLine: Boolean(detail.publish?.testLine?.trim()) },
    notes: { state: notes.state, source: notes.source, bytes: notes.bytes, truncated: notes.truncated,
      nonempty: Boolean(notes.text.trim()), sameRepo, otherRepos },
  };
}

/** Exit 0 only for a complete match, 1 for incomplete evidence, 2 for bad arguments. */
export async function runFleetHandoffCheck(args: string[], options: {
  readers?: Readers; write?: (value: string) => void;
} = {}): Promise<number> {
  const write = options.write ?? (value => console.log(value));
  let job: string | undefined, repo: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--job' && job === undefined) job = args[++i];
    else if (arg === '--repo' && repo === undefined) repo = args[++i];
    else if (arg === '--json' && !json) json = true;
    else { write(JSON.stringify({ error: 'invalid_arguments' })); return 2; }
  }
  if (!job || !isFleetJobId(job) || !repo || !repoPattern.test(repo) || /[\r\n]/.test(repo) || !json) {
    write(JSON.stringify({ error: 'invalid_arguments' })); return 2;
  }
  try {
    const result = await checkFleetHandoff(job, repo, options.readers);
    write(JSON.stringify(result));
    return result.complete ? 0 : 1;
  } catch {
    write(JSON.stringify({ error: 'read_failed' })); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runFleetHandoffCheck(process.argv.slice(2));
}
