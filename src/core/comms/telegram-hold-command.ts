import { parseReleaseCommand } from './telegram-release-command.js';

export function parseHoldCommand(text: string): { lane: string; minutes: number; reason: string } | null {
  const match = /^\s*\/hold(?:@\w+)?\s+(\S+)\s+(\d+)(?:[ \t]+([\x20-\x7e]+))?[ \t]*$/i.exec(text);
  const lane = match?.[1];
  const minutes = match?.[2] === undefined ? NaN : Number(match[2]);
  const rawReason = match?.[3];
  if (!lane || !parseReleaseCommand(`/release ${lane}`) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440 || (rawReason !== undefined && rawReason.length > 120)) return null;
  return { lane, minutes, reason: rawReason?.trim() || 'held from Telegram' };
}

export type HoldReply =
  | { status: 'held'; lane: string; heldUntil: string }
  | { status: 'failed'; reason: 'manual-hold' | 'unknown-lane' | 'unavailable' }
  | { status: 'usage' };

/** Only fixed failure messages are exposed; filesystem errors may contain secrets. */
export function renderHoldReply(result: HoldReply): string {
  if (result.status === 'usage') return 'Usage: /hold <lane> <minutes> [reason]';
  if (result.status === 'held') return `${result.lane} held until ${result.heldUntil}.`;
  const reason = { 'manual-hold': 'a person’s hold remains in place', 'unknown-lane': 'lane is unavailable', unavailable: 'lane holds unavailable' }[result.reason];
  return `Hold failed: ${reason}.`;
}
