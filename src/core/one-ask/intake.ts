/**
 * One-ask intake. Scope is structured, supplied by the trusted caller; the
 * ask is opaque data and cannot add, remove, or authorize targets. This is a
 * preflight for declared files, not an execution sandbox or a diff gate.
 */
import { matchProtectedPath, normalizeRepoPath, PROTECTED_PATH_RULES, testContentImportsTier1 } from '../authority/protected-paths.js';
import { listRepoHolds, NAME_WITH_OWNER_RE } from '../fleet/quarantine.js';
import type { RepoHold } from '../fleet/fleet-types.js';

export interface OneAskTarget {
  repo: string;
  /** Complete concrete file paths, not directories, globs or inferred prose. */
  files: readonly { path: string; baseContent?: string | null }[];
}

export interface OneAskRequest {
  text: string;
  targets: readonly OneAskTarget[];
}

export type OneAskIntake =
  | { ok: true; request: OneAskRequest }
  | { ok: false; code: string; reason: string };

const refuse = (code: string, reason: string): OneAskIntake => ({ ok: false, code, reason });

/**
 * `readHolds` must return the current active holds, or throw on unknown state.
 * Supply baseContent for test files from a trusted snapshot (null for a new
 * file). A caller must recheck scope and holds at execution and review the diff.
 */
export function intakeOneAsk(
  request: OneAskRequest,
  readHolds: () => readonly RepoHold[] = listRepoHolds,
): OneAskIntake {
  if (!request || typeof request.text !== 'string' || !request.text.trim()) {
    return refuse('empty-ask', 'Describe the ask before intake.');
  }
  if (!Array.isArray(request.targets) || request.targets.length !== 1) {
    return refuse('repo-count', 'An ask must target exactly one repository.');
  }
  const target = request.targets[0];
  if (!target || typeof target.repo !== 'string' || !NAME_WITH_OWNER_RE.test(target.repo)) {
    return refuse('invalid-repo', 'The repository must be an owner/name identity.');
  }
  if (!Array.isArray(target.files) || target.files.length === 0) {
    return refuse('missing-files', 'Declare the concrete files the ask targets.');
  }
  // Literal references in the ask can only narrow admission, never grant it.
  // Structured scope is still required: prose cannot reliably enumerate work.
  const owner = target.repo.split('/')[0]!.toLowerCase();
  const references = request.text.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g) ?? [];
  for (const ref of references) {
    const parts = ref.split('/');
    const github = parts[0]!.toLowerCase() === 'github.com';
    const repo = github && parts.length >= 3 ? `${parts[1]}/${parts[2]}`
      : parts.length === 2 && parts[0]!.toLowerCase() === owner ? ref : null;
    if (repo && repo.toLowerCase() !== target.repo.toLowerCase()) {
      return refuse('repo-count', 'The ask refers to another repository; target one repository per ask.');
    }
    const path = github ? parts.slice(3).join('/') : ref;
    if (path && (path.toLowerCase().startsWith('.github/') || matchProtectedPath(path, { selfRepo: true }))) {
      return refuse('protected-path', `${path}: the ask references a protected path.`);
    }
  }
  if (/(?:^|[^A-Za-z0-9._-])\.github(?:$|[^A-Za-z0-9._-])/i.test(request.text)) {
    return refuse('protected-path', 'The ask references .github, which is reserved for the owner.');
  }
  let holds: readonly RepoHold[];
  try {
    holds = readHolds();
    if (!Array.isArray(holds)) throw new Error('invalid holds');
  } catch {
    return refuse('holds-unavailable', 'Repository holds could not be read; intake is refused.');
  }
  const hold = holds.find((item) => item.repo.toLowerCase() === target.repo.toLowerCase());
  if (hold) return refuse('repo-held', `${target.repo} is on hold (${hold.kind}): ${hold.reason}`);

  for (const file of target.files) {
    if (!file || typeof file.path !== 'string') return refuse('invalid-path', 'Every target must have a concrete file path.');
    const path = normalizeRepoPath(file.path);
    if (!path || /[*?[\]{}]/.test(path) || /^[a-z]:/i.test(path)) {
      return refuse('invalid-path', 'Target paths must be concrete, repository-relative file paths.');
    }
    // Directory roots and globs are ambiguous; the caller must expand them to
    // files before this boundary. Applying self-repo rules everywhere is
    // intentionally conservative when repository identity is not verified.
    if (path.toLowerCase() === '.github' || path.toLowerCase().startsWith('.github/')) {
      return refuse('protected-path', `${path}: .github paths are reserved for the owner.`);
    }
    const lower = path.toLowerCase();
    if (lower === 'test' || PROTECTED_PATH_RULES.some((rule) =>
      rule.patterns.some((pattern) => pattern.toLowerCase().startsWith(`${lower}/`)),
    )) {
      return refuse('protected-path', `${path}: this target contains protected paths; declare concrete files.`);
    }
    const isTest = /^test\/.*\.[cm]?[jt]sx?$/i.test(path);
    if (isTest && file.baseContent !== null && typeof file.baseContent !== 'string') {
      return refuse('test-content-unknown', `${path}: the trusted base content is required to classify this test.`);
    }
    const imports = isTest && testContentImportsTier1(path, [file.baseContent ?? null]);
    const hit = matchProtectedPath(path, {
      selfRepo: true,
      ...(imports ? { testsImportingTier1: new Set([path]) } : {}),
    });
    if (hit) return refuse('protected-path', `${hit.path}: ${hit.why}`);
  }
  return { ok: true, request: { text: request.text, targets: [{ repo: target.repo, files: target.files.map((file: OneAskTarget['files'][number]) => ({ ...file })) }] } };
}
