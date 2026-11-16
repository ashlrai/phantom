import type { ReleaseChainStatus } from '../../../../core/fleet/release-chain-status.js';

export function releaseChainLine(result: ReleaseChainStatus | null | undefined, nowMs: number): { step: string; reason: string; ageText: string } | null {
  if (!result || (result.verdict !== 'held' && result.verdict !== 'failed') || typeof result.reason !== 'string' || !result.reason.trim()) return null;
  const at = Date.parse(result.latestAutorun?.mtime ?? '');
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;
  const seconds = Math.floor(Math.max(0, nowMs - at) / 1000);
  const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
  const reason = result.reason.trim();
  return { step: 'desktop signing', reason: reason.length > 160 ? `${reason.slice(0, 159)}…` : reason, ageText: `${age} ago` };
}
