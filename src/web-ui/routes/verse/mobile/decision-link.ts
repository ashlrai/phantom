export function decisionPrUrl(repo: string, prNumber: number | null): string | null {
  return /^[\w.-]+\/[\w.-]+$/.exec(repo)?.[0] === repo && typeof prNumber === 'number' && Number.isInteger(prNumber) && prNumber > 0
    ? `https://github.com/${repo}/pull/${prNumber}` : null;
}
