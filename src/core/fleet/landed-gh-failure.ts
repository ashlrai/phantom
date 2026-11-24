/** Safe, fixed diagnostics for a failed gh process; never expose its output. */
export interface GhFailure {
  kind: 'missing' | 'signed-out' | 'offline' | 'error';
  reason: string;
}

export function describeGhFailure(run: { stderr: string; missing?: boolean; timedOut?: boolean }): GhFailure {
  if (run.missing) return { kind: 'missing', reason: 'gh not installed' };
  if (run.timedOut) return { kind: 'offline', reason: 'network unreachable' };
  if (/gh auth login|not logged in|authentication required|bad credentials|http 401|GH_TOKEN/i.test(run.stderr)) {
    return { kind: 'signed-out', reason: 'gh not signed in' };
  }
  if (/could not resolve host|network is unreachable|connection (refused|reset|timed out)|dial tcp|timeout|no route to host|tls handshake/i.test(run.stderr)) {
    return { kind: 'offline', reason: 'network unreachable' };
  }
  return { kind: 'error', reason: 'gh failed' };
}
