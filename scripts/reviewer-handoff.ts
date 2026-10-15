/** Local reviewer context, never merge authority, an approval or release evidence. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { globMatches, isTestPath, matchProtectedPath, normalizeRepoPath, testContentImportsTier1 } from '../src/core/authority/protected-paths.js';
// @ts-expect-error Existing standalone gate helpers have no declaration file.
import { loadSmoke, lockfileDependencyChanged, packageDependencyChanges, planTests } from './gate.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const questions = {
  authority: 'Check existing owner-lane rules, grant/enrollment/Stop boundaries and capability changes.',
  filesystem: 'Check physical paths, ownership, links, lock races, atomic writes and interrupted recovery.',
  financial: 'Check units, subscription/gift evidence, expiry, reservations and refusal of unknown or paid funding.',
  identity: 'Check account/profile/host binding, authentication, freshness and truthful unknown states.',
  runtime: 'Check cancellation, process ownership, startup/shutdown and natural-cycle evidence.',
  publication: 'Check exact source, original coverage/artifacts, immutable versions and public readback.',
  regular: 'Review the behavior and edge cases; unmatched focus labels are not a safety guarantee.',
} as const;
type Focus = keyof typeof questions;

function git(root: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0', ...args], { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: MAX_BYTES });
  if (result.status !== 0 || result.error || result.signal) throw new Error(`Git read failed (${args[0]})`);
  return result.stdout;
}
function revision(root: string, ref: string): string {
  if (!ref || ref.startsWith('-')) throw new Error('A base/head ref is required');
  const sha = git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid source revision');
  return sha;
}
function metadata(root: string, ref: string, path: string) {
  const text = git(root, ['ls-tree', '-z', ref, '--', path]);
  if (!text) return null;
  const row = /^([0-7]{6}) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(text);
  if (!row || row[3] !== path) throw new Error('Ambiguous source path');
  return { mode: row[1], blob: row[2] };
}
function content(root: string, ref: string, path: string): string | null {
  const row = metadata(root, ref, path);
  if (!row || !['100644', '100755'].includes(row.mode)) return null;
  const size = Number(git(root, ['cat-file', '-s', row.blob]).trim());
  if (!Number.isSafeInteger(size) || size > 1024 * 1024) throw new Error('Source input exceeds its read bound');
  return git(root, ['cat-file', 'blob', row.blob]);
}
function owners(text: string | null, path: string): { owners: string[]; incomplete: boolean } {
  if (text === null) return { owners: [], incomplete: true };
  let selected: string[] = []; let incomplete = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#')) continue;
    const [pattern, ...names] = trimmed.split(/\s+/);
    if (!pattern || !names.length || !names.every((name) => /^@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9._-]+)?$/.test(name))) {
      incomplete = true; continue;
    }
    // Generated CODEOWNERS uses the protected-path module's reviewed glob forms.
    // Unsupported custom lines stay unknown instead of inventing a reviewer.
    if (pattern.includes('\\') || pattern.includes('[') || pattern.includes('!')) { incomplete = true; continue; }
    if (globMatches(pattern.replace(/^\//, ''), path)) selected = names;
  }
  return { owners: selected, incomplete };
}
function focus(path: string, protectedPath: boolean, modeChange: boolean): Focus[] {
  const value = path.toLowerCase(); const out = new Set<Focus>();
  if (protectedPath) out.add('authority');
  if (modeChange || /(?:path|file|store|lock|lease|journal|sandbox|recovery|durability)/.test(value)) out.add('filesystem');
  if (/(?:budget|billing|funding|subscription|credit|quota|allocation|spend)/.test(value)) out.add('financial');
  if (/(?:identity|auth|custody|grant|profile|enroll|locus)/.test(value)) out.add('identity');
  if (value.startsWith('desktop/') || /(?:daemon|runtime|process|connection-monitor|\/verse\.)/.test(value)) out.add('runtime');
  if (/(?:release|publish|install|build|promotion)/.test(value) || value.startsWith('.github/workflows/')) out.add('publication');
  return out.size ? [...out] : ['regular'];
}

/** Counts are verified against serialized cases, not authenticated execution. */
export function summarizeTestEvidence(data: unknown) {
  const record = data as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { kind: 'unknown', reportedExecution: 'unknown', countsVerified: false };
  if (record.checksExecuted === false || record.mode === 'plan') return { kind: 'plan', reportedExecution: 'not-executed', countsVerified: false };
  if (!Array.isArray(record.testResults)) return { kind: 'unknown', reportedExecution: 'unknown', countsVerified: false };
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 }; let modules = 0;
  for (const raw of record.testResults) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.assertionResults)) throw new Error('Invalid test report module');
    modules++;
    for (const assertion of raw.assertionResults) {
      const state = assertion?.status as keyof typeof counts;
      if (!Object.hasOwn(counts, state)) throw new Error('Invalid serialized test status');
      counts[state]++;
    }
  }
  if (!modules || Object.values(counts).reduce((a, b) => a + b, 0) !== record.numTotalTests ||
    counts.passed !== record.numPassedTests || counts.failed !== record.numFailedTests ||
    counts.skipped !== record.numPendingTests || counts.todo !== record.numTodoTests) throw new Error('Serialized test counts disagree');
  const failed = record.success !== true || counts.failed > 0 || record.numFailedTestSuites !== 0;
  return { kind: 'vitest', reportedExecution: failed ? 'failed' : counts.passed > 0 ? 'passed' : 'unknown',
    countsVerified: true, modules, counts };
}
/** Read at most the admitted size plus one byte, even if a writer grows the inode. */
export function readBoundedReport(fd: number, size: number,
  read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number = readSync): Buffer {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw new Error('Unsafe report size');
  const bytes = Buffer.alloc(size + 1); let used = 0;
  while (used < bytes.length) {
    const count = read(fd, bytes, used, Math.min(64 * 1024, bytes.length - used), used);
    if (!count) break;
    used += count;
  }
  if (used !== size) throw new Error('Report size changed while reading');
  return bytes.subarray(0, used);
}
function evidence(root: string, path: string, head: string, tree: string) {
  const absolute = resolve(root, path); const name = basename(absolute);
  if (!name.endsWith('.json') || /(?:secret|credential|\.env)/i.test(name)) throw new Error('Use a JSON test report, not sensitive material');
  const before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES || realpathSync(absolute) !== absolute) throw new Error('Unsafe evidence reference');
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error('Evidence reference changed');
    bytes = readBoundedReport(fd, opened.size); const after = fstatSync(fd);
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error('Evidence changed while reading');
  } finally { closeSync(fd); }
  const retained = lstatSync(absolute);
  if (retained.dev !== before.dev || retained.ino !== before.ino || retained.size !== before.size ||
    retained.mtimeMs !== before.mtimeMs || retained.ctimeMs !== before.ctimeMs) throw new Error('Evidence reference changed');
  const parsed = JSON.parse(bytes.toString('utf8')); const summary = summarizeTestEvidence(parsed);
  const source = parsed.source as { revision?: unknown; tree?: unknown } | undefined;
  const sourceBinding = !source ? 'unreported' : source.revision === head && source.tree === tree ? 'reported-match' : 'mismatch';
  const rel = relative(root, absolute);
  return { reference: rel.startsWith('..') || isAbsolute(rel) ? '<external report>' : rel,
    sha256: digest(bytes), bytes: bytes.length, sourceBinding, ...summary, executionProvenance: 'not-verified' };
}

export function collectReviewerHandoff({ root, base = 'origin/master', head = 'HEAD', evidencePaths = [] }: {
  root: string; base?: string; head?: string; evidencePaths?: string[];
}) {
  root = realpathSync(root);
  const baseSha = revision(root, base); const headSha = revision(root, head);
  const currentHead = revision(root, 'HEAD'); const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const baseTree = git(root, ['rev-parse', `${baseSha}^{tree}`]).trim(); const headTree = git(root, ['rev-parse', `${headSha}^{tree}`]).trim();
  const mergeBase = git(root, ['merge-base', baseSha, headSha]).trim();
  const raw = git(root, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', baseSha, headSha, '--']);
  if (raw && !raw.endsWith('\0')) throw new Error('Incomplete changed-path inventory');
  const parts = raw.split('\0').filter(Boolean); if (parts.length % 2 || parts.length > 2000) throw new Error('Changed-path inventory exceeds its bound');
  const packageBefore = content(root, baseSha, 'package.json'); const packageAfter = content(root, headSha, 'package.json');
  const packageName = packageAfter ? JSON.parse(packageAfter).name : null;
  const selfRepo = packageName === '@ashlr/hub' || packageName === '@ashlr/phantom';
  const ownershipBefore = content(root, baseSha, '.github/CODEOWNERS'); const ownershipAfter = content(root, headSha, '.github/CODEOWNERS');
  const unknowns = new Set<string>();
  const changedPaths = [];
  for (let i = 0; i < parts.length; i += 2) {
    const change = parts[i]!; const path = parts[i + 1]!;
    if (!/^[AMDT]$/.test(change) || normalizeRepoPath(path) !== path) throw new Error('Unknown or unsafe changed path');
    const before = metadata(root, baseSha, path); const after = metadata(root, headSha, path);
    const testContents = isTestPath(path) ? [content(root, baseSha, path), content(root, headSha, path)] : [];
    const imports = testContentImportsTier1(path, testContents);
    const hit = matchProtectedPath(path, { selfRepo, testsImportingTier1: imports ? new Set([path]) : new Set() });
    const previous = owners(ownershipBefore, path); const next = owners(ownershipAfter, path);
    if (previous.incomplete || next.incomplete) unknowns.add('CODEOWNERS is absent or has unsupported lines; reviewer references may be incomplete.');
    const reviewFocus = focus(path, hit !== null, before?.mode !== after?.mode);
    changedPaths.push({ path, change, before, after, existingOwnerLane: hit,
      codeownersBefore: previous.owners, codeownersAfter: next.owners, reviewFocus });
  }
  const changed = changedPaths.map((row) => row.path);
  const dependencyKeys = changed.includes('package.json') ? packageDependencyChanges(packageBefore, packageAfter) : [];
  const lockfileChanged = changed.includes('package-lock.json') && lockfileDependencyChanged(content(root, baseSha, 'package-lock.json'), content(root, headSha, 'package-lock.json'));
  let affectedPlan: Record<string, { mode: string; reason: string; files: string[] }> | null = null;
  try {
    const smoke = loadSmoke(JSON.parse(content(root, headSha, 'scripts/gate-smoke.json') ?? 'null'));
    affectedPlan = planTests({ full: false, changed, dependencyKeys, lockfileChanged, smoke });
  } catch { unknowns.add('Source-owned smoke selection is missing or invalid; affected selectors are unavailable.'); }
  if (status) unknowns.add('Dirty and untracked working-tree changes are excluded; this handoff compares only the named commits.');
  if (mergeBase !== baseSha) unknowns.add('Base is not an ancestor of head; the exact two-tree comparison may include reversed changes.');
  const observedEvidence = evidencePaths.map((path) => evidence(root, path, headSha, headTree));
  if (!observedEvidence.length) unknowns.add('No test evidence references were supplied.');
  if (observedEvidence.some((item) => item.sourceBinding !== 'reported-match')) unknowns.add('Some supplied reports do not claim the reviewed head/tree; they cannot prove exact-source checks.');
  if (revision(root, base) !== baseSha || revision(root, head) !== headSha || revision(root, 'HEAD') !== currentHead ||
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']) !== status) throw new Error('Source changed during handoff observation');
  const focuses = [...new Set(changedPaths.flatMap((row) => row.reviewFocus))];
  return { scope: 'local-development-feedback', checksExecuted: false, releaseAdmission: false,
    source: { base: baseSha, head: headSha, baseTree, headTree, mergeBase, currentHead, dirtyExcluded: status.length > 0 },
    changedPaths, reviewQuestions: focuses.map((kind) => ({ focus: kind, question: questions[kind] })),
    suggestedChecks: ['npm run check:version', 'npm run check:docs', 'npm run typecheck', 'npm run lint'],
    changedTestFiles: changed.filter(isTestPath), affectedPlan, evidence: observedEvidence,
    reviewEvidence: { agentReview: 'not-proven', humanReview: 'not-proven' }, unknowns: [...unknowns],
    limitations: [
      'Focus labels and affected selectors are advisory, not a complete import/dependency graph; file reads, generated inputs and dynamic loading may be invisible.',
      'Report counts are checked against serialized cases; references and matching source claims do not authenticate execution or independent review.',
      'Existing CODEOWNERS, standing authority and qualified automated merge apply; this tool adds no approval-count or mandatory human-review gate.',
      'CODEOWNERS references use the existing local protected-glob matcher; live GitHub reviewer assignment and branch settings are not verified.',
      'Full release qualification, original artifact/provenance checks and publication/runtime acceptance remain separate.',
      'Renames are represented as deletion plus addition so both ownership boundaries remain visible. No other repositories or client graph are inspected.',
    ] };
}

export function renderReviewerHandoff(report: ReturnType<typeof collectReviewerHandoff>): string {
  const safe = (value: string) => JSON.stringify(value).replaceAll('`', '\\`').replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return ['## Reviewer handoff', '', `Exact base: \`${report.source.base}\`; head: \`${report.source.head}\`; tree: \`${report.source.headTree}\`.`,
    '', 'Local review context only; no checks, approvals or publication were performed.', '', '### Files and existing ownership', '',
    ...report.changedPaths.map((row) => `- ${row.change} \`${safe(row.path)}\` — ${row.reviewFocus.join(', ')}; existing owner lane: ${row.existingOwnerLane?.ruleId ?? 'not matched'}; CODEOWNERS refs: ${[...new Set([...row.codeownersBefore, ...row.codeownersAfter])].join(', ') || 'none observed'}.`),
    '', '### Review questions', '', ...report.reviewQuestions.map((row) => `- ${row.question}`),
    '', '### Existing checks and affected selectors', '',
    ...report.suggestedChecks.map((command) => `- \`${command}\` (suggested; not executed by this tool).`),
    ...report.changedTestFiles.map((file) => `- Changed test: \`${safe(file)}\`.`),
    ...(report.affectedPlan ? Object.entries(report.affectedPlan).flatMap(([suite, plan]) => [
      `- Advisory ${suite} selection: ${plan.mode}; ${plan.reason}.`,
      ...plan.files.map((file: string) => `  - \`${safe(file)}\``),
    ]) : ['- Affected selectors unavailable; review the reported unknowns.']),
    '', '### Verification references', '', ...report.evidence.map((item) => `- \`${safe(item.reference)}\` SHA256 \`${item.sha256}\`: reported execution ${item.reportedExecution}, source ${item.sourceBinding}, serialized counts verified ${item.countsVerified}. Execution provenance not verified.`),
    '', 'Agent review: not proven. Human review: not proven. Record each actual reviewer and findings separately; agent review does not establish human review.',
    '', '### Unknowns and limits', '', ...[...report.unknowns, ...report.limitations].map((line) => `- ${line}`), ''].join('\n');
}

export function parseReviewerHandoffArgs(args: string[]) {
  const result = { base: 'origin/master', head: 'HEAD', evidencePaths: [] as string[], json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]; if (arg === '--json') { result.json = true; continue; }
    if (!['--base', '--head', '--evidence'].includes(arg!)) throw new Error('Use --base REF --head REF [--evidence REPORT.json] [--json]');
    const value = args[++i]; if (!value || value.startsWith('-')) throw new Error('Missing handoff argument');
    if (arg === '--base') result.base = value; else if (arg === '--head') result.head = value; else result.evidencePaths.push(value);
  }
  if (result.evidencePaths.length > 20) throw new Error('Too many evidence references');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseReviewerHandoffArgs(process.argv.slice(2));
    const report = collectReviewerHandoff({ root: process.cwd(), ...args });
    console.log(args.json ? JSON.stringify(report, null, 2) : renderReviewerHandoff(report));
  } catch {
    // Parser and filesystem errors can contain private input text or paths.
    console.error('Reviewer handoff unavailable: source, arguments or evidence could not be verified.'); process.exitCode = 1;
  }
}
