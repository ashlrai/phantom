/** Draft-job paths compared with a git ref. No process spawn lives here. */

const SKIP_LINE = /do not edit|never touch/i;
/** Repo-relative file with a known prefix and an extension. Segments cannot be `.` or `..`. */
const PATH_RE = /(?<![A-Za-z0-9_./-])((?:src|test|docs|schema|scripts)(?:\/[A-Za-z0-9_@-][A-Za-z0-9_@.-]*)+\.[A-Za-z0-9]+)/g;
const BRIDGE_SUBJECT = /bridge\(RQ-[A-Za-z0-9-]+\)/;
const MAX_PATH = 240;

export interface PrecheckFact {
  path: string;
  onMaster: boolean;
  lastCommit?: { sha: string; subject: string };
}

export interface JobPrecheckGit {
  exists(path: string): Promise<boolean>;
  lastCommit(path: string): Promise<{ sha: string; subject: string } | null>;
}

export function extractJobPaths(markdown: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (SKIP_LINE.test(line)) continue;
    PATH_RE.lastIndex = 0;
    for (const match of line.matchAll(PATH_RE)) {
      const path = match[1];
      if (!path || path.length > MAX_PATH || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function isTestPath(path: string): boolean {
  return path.startsWith('test/') || (path.startsWith('src/') && /\.(?:test|spec)\.[A-Za-z0-9]+$/.test(path));
}

function bridgeLanded(fact: PrecheckFact): boolean {
  return fact.onMaster && !!fact.lastCommit && BRIDGE_SUBJECT.test(fact.lastCommit.subject);
}

export async function precheckJob(
  markdown: string,
  git: JobPrecheckGit,
): Promise<{ facts: PrecheckFact[]; newTestFiles: string[]; verdict: 'fresh' | 'partly-on-master' | 'likely-done' }> {
  const facts: PrecheckFact[] = [];
  for (const path of extractJobPaths(markdown)) {
    const onMaster = await git.exists(path);
    const commit = onMaster ? await git.lastCommit(path) : null;
    const fact: PrecheckFact = { path, onMaster };
    if (commit) fact.lastCommit = commit;
    facts.push(fact);
  }
  const src = facts.filter(fact => fact.path.startsWith('src/'));
  const work = src.filter(fact => !isTestPath(fact.path));
  // likely-done needs real non-test src work. A test-only list is not a landed feature.
  const verdict = !src.some(fact => fact.onMaster) ? 'fresh'
    : work.length > 0 && work.every(bridgeLanded) ? 'likely-done'
    : 'partly-on-master';
  return {
    facts,
    newTestFiles: facts.filter(fact => isTestPath(fact.path) && !fact.onMaster).map(fact => fact.path),
    verdict,
  };
}
