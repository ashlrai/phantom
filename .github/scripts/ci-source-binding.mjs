/* global process, console */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const shaPattern = /^[a-f0-9]{40}$/;
// eventBase and eventHead come only from the GitHub event payload (pull_request.base.sha
// and pull_request.head.sha), never from refs. They are needed only when the candidate
// (the PR head) differs from the event revision (GitHub's synthetic merge commit).
export function bindSource({ root, candidate, eventSha, eventBase, eventHead, runGit } = {}) {
  if (!shaPattern.test(candidate) || !shaPattern.test(eventSha)) throw new Error('Invalid candidate or event revision');
  const git = runGit ?? ((args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim());
  if (git(['rev-parse', 'HEAD']) !== candidate) throw new Error('Checkout is not the candidate revision');
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Source checkout is dirty');
  if (candidate !== eventSha) git(['fetch', '--no-tags', 'origin', eventSha]);
  const tree = git(['rev-parse', `${candidate}^{tree}`]);
  if (!shaPattern.test(tree)) throw new Error('Candidate tree differs from the original GitHub event tree');
  const treeDiffers = git(['rev-parse', `${eventSha}^{tree}`]) !== tree;
  if (!treeDiffers) return { revision: candidate, tree, eventSha };
  // Behind-base pull_request: the event revision is GitHub's merge of base into head.
  // Accept only if the candidate IS the event head, the event commit's parents are
  // exactly (event base, event head), and its tree equals a local clean merge of them.
  if (!shaPattern.test(eventBase ?? '') || !shaPattern.test(eventHead ?? '') || candidate !== eventHead) {
    throw new Error('Candidate tree differs from the original GitHub event tree');
  }
  const parents = git(['rev-list', '--parents', '-n', '1', eventSha]).split(' ');
  if (parents.length !== 3 || parents[0] !== eventSha || parents[1] !== eventBase || parents[2] !== eventHead) {
    throw new Error('GitHub event merge parents differ from the event base and head');
  }
  const eventTree = git(['rev-parse', `${eventSha}^{tree}`]);
  let merged;
  try { merged = git(['merge-tree', '--write-tree', '--no-messages', eventBase, eventHead]); }
  catch { throw new Error('Event base and head do not merge cleanly'); }
  if (!shaPattern.test(merged) || merged !== eventTree) throw new Error('GitHub event merge tree differs from the local merge of event base and head');
  return { revision: candidate, tree, eventSha, eventTree, eventBase };
}

function eventPair(path) {
  if (!path) return {};
  const pr = JSON.parse(readFileSync(path, 'utf8')).pull_request;
  return pr ? { eventBase: pr.base?.sha, eventHead: pr.head?.sha } : {};
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const source = bindSource({ root: process.cwd(), candidate: process.env.ASHLR_CANDIDATE_SHA, eventSha: process.env.GITHUB_SHA,
      ...(process.env.GITHUB_EVENT_NAME === 'pull_request' ? eventPair(process.env.GITHUB_EVENT_PATH) : {}) });
    if (!process.env.GITHUB_ENV) throw new Error('Missing GitHub environment output');
    appendFileSync(process.env.GITHUB_ENV, `ASHLR_CI_SOURCE_SHA=${source.revision}\nASHLR_CI_EVENT_SHA=${source.eventSha}\n`);
    console.log(source.eventTree ? `Bound candidate ${source.revision} to event merge ${source.eventSha} of base ${source.eventBase}`
      : `Bound candidate ${source.revision} to event tree ${source.tree}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
