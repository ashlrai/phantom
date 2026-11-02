type Verdict = 'match' | 'downgrade' | 'ahead' | 'unknown';

const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const verdicts: readonly unknown[] = ['match', 'downgrade', 'ahead', 'unknown'];

/** Interpret the optional release-read fields without depending on another view's types. */
export function releaseVerdictLine(entry: unknown, prVersion: string | null): { verdict: Verdict; blocked: boolean; line: string | null } {
  const unknown = { verdict: 'unknown', blocked: false, line: null } as const;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return unknown;
  const { treeVersion, versionVerdict } = entry as { treeVersion?: unknown; versionVerdict?: unknown };
  if (typeof treeVersion !== 'string' || !versionPattern.test(treeVersion)
    || typeof prVersion !== 'string' || !versionPattern.test(prVersion)) return unknown;

  let verdict: Verdict;
  if (versionVerdict === undefined) {
    const pr = prVersion.split('.').map(Number);
    const tree = treeVersion.split('.').map(Number);
    const difference = pr[0]! - tree[0]! || pr[1]! - tree[1]! || pr[2]! - tree[2]!;
    verdict = difference < 0 ? 'downgrade' : difference > 0 ? 'ahead' : 'match';
  } else if (verdicts.includes(versionVerdict)) {
    verdict = versionVerdict as Verdict;
  } else {
    return unknown;
  }
  return {
    verdict,
    blocked: verdict === 'downgrade',
    line: verdict === 'downgrade' ? `Would ship ${prVersion}, tree targets ${treeVersion} · blocked` : null,
  };
}
