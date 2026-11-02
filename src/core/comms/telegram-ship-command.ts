import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { scrubSecrets } from '../util/scrub.js';
import { mergeReleasePr, probeReleasePr, type ReleasePrV1 } from '../verse/ops-release-pr.js';
import type { OpsRunner } from '../verse/ops-releases.js';

export const TELEGRAM_SHIP_RE = /^\/ship(?:@\w+)?(?:\s+(confirm))?\s*$/i;
export interface ShipCommandDeps {
  probe?: typeof probeReleasePr;
  merge?: typeof mergeReleasePr;
  run?: OpsRunner;
  now?: () => number;
  repo?: string;
}

const realRunner: OpsRunner = (bin, args) => new Promise((resolve) => {
  try {
    execFile(bin, [...args], {
      cwd: homedir(), timeout: 12_000, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GH_HOST: 'github.com', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    }, (error, stdout) => resolve(error ? null : stdout.trim()));
  } catch { resolve(null); }
});

let pending: { number: number; updatedAt: string; expiresAt: number; repo: string } | null = null;
let generation = 0;
let confirming = false;
const clean = (value: string): string => scrubSecrets(value.replace(/\b(?:https?|ftp):\/\/[^\s<>]+/gi, '[link removed]'));
const green = (pr: ReleasePrV1): boolean =>
  !pr.blocked && pr.mergeable !== 'CONFLICTING' && pr.pending === 0 && pr.failing.length === 0;

/** A confirmation consumes its arm before any I/O, preventing duplicate merges. */
export async function shipCommandReply(text: string, deps: ShipCommandDeps = {}): Promise<string | null> {
  const match = TELEGRAM_SHIP_RE.exec(text);
  if (!match) return null;
  if (confirming) return clean('A release confirmation is already in progress.');
  let ownsConfirmation = false;
  const currentGeneration = ++generation;
  const armed = pending;
  pending = null;
  const now = deps.now ?? Date.now;
  const repo = deps.repo ?? 'ashlrai/phantom';
  const probe = deps.probe ?? probeReleasePr;
  const run = deps.run ?? realRunner;
  try {
    if (match[1]) {
      if (!armed || now() >= armed.expiresAt || armed.repo !== repo) return clean('Nothing armed, send /ship first.');
      confirming = true;
      ownsConfirmation = true;
      const pr = await probe(repo, run);
      if (!pr) return clean('Release PR unavailable; send /ship first.');
      if (pr.number !== armed.number) return clean(`Release PR changed to #${pr.number}; send /ship first.`);
      if (!green(pr)) return clean(`Release PR #${pr.number} is no longer ready: ${pr.mergeable === 'CONFLICTING' ? 'merge conflicts' : pr.summary}`);
      if (!pr.updatedAt || pr.updatedAt !== armed.updatedAt) return clean(`Release PR #${pr.number} changed; send /ship first.`);
      const result = await (deps.merge ?? mergeReleasePr)(repo, pr.number, run);
      return clean(result.ok
        ? `Merged #${pr.number} (sha ${result.sha ?? 'unavailable'}). The desktop updates itself on its next check.`
        : result.detail);
    }
    const pr = await probe(repo, run);
    if (!pr) return clean('No open release PR found, or release status is unavailable.');
    const lines = [`Release PR #${pr.number}: ${pr.title}`, `Version: ${pr.version ?? 'unavailable'}`, pr.summary];
    if (pr.mergeable === 'CONFLICTING') lines.push('Blocked: merge conflicts.');
    else if (pr.failing.length) lines.push(`Failing checks: ${pr.failing.join(', ')}`);
    else if (pr.pending > 0) lines.push(`Pending checks: ${pr.pending}`);
    else if (pr.blocked) lines.push('Blocked: release checks are not green.');
    if (green(pr) && pr.updatedAt && currentGeneration === generation) {
      pending = { number: pr.number, updatedAt: pr.updatedAt, expiresAt: now() + 10 * 60_000, repo };
      lines.push('Reply /ship confirm within 10 minutes to merge.');
    } else if (green(pr) && !pr.updatedAt) lines.push('Cannot arm: PR update time is unavailable.');
    return clean(lines.join('\n'));
  } catch {
    return clean('Release PR request failed; send /ship first.');
  } finally {
    if (ownsConfirmation) confirming = false;
  }
}
