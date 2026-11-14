/** Return receipts are evidence only; the lease fences the release, not the sender label. */
import { postFleetMessage, readFleetBoard, releaseFleetClaim, type FleetCoordinationOptions, type FleetMessage } from './coordination.js';

export interface FleetClaimReturnInput {
  id: string; agent: string; lease: string; ttlMs?: number;
  pr?: number | string; head?: string; tests?: string; artifact?: string; blocked?: string;
}
export interface FleetClaimReturnResult {
  ok: boolean;
  outcome: 'returned' | 'already-returned' | 'invalid-input' | 'unavailable' | 'not-owner' | 'not-found' | 'released-unposted';
  claimId: string;
  message?: FleetMessage;
  body?: string;
  id?: string;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DAY = 24 * 60 * 60_000;
const fold = (text: string): string => Array.from(text, character => {
  const code = character.charCodeAt(0);
  return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : character;
}).join('');

/** Validate every result form before releasing; never interpret result text. */
function resultText(input: FleetClaimReturnInput): string | null {
  const { pr, head, tests, artifact, blocked } = input;
  if (Number(pr !== undefined || head !== undefined) + Number(tests !== undefined)
    + Number(artifact !== undefined) + Number(blocked !== undefined) !== 1) return null;
  if (pr !== undefined || head !== undefined) {
    const n = typeof pr === 'number' ? pr : typeof pr === 'string' && /^[1-9]\d*$/.test(pr) ? Number(pr) : NaN;
    return Number.isSafeInteger(n) && n > 0 && typeof head === 'string' && /^[a-fA-F0-9]{7,40}$/.test(head)
      ? `pr #${n} head ${head}` : null;
  }
  const text = tests ?? artifact ?? blocked;
  if (typeof text !== 'string' || !fold(text).trim()) return null;
  return `${tests !== undefined ? 'tests' : artifact !== undefined ? 'artifact' : 'dependency'} ${fold(text)}`;
}
export function returnFleetClaim(input: FleetClaimReturnInput, options: FleetCoordinationOptions = {}): FleetClaimReturnResult {
  const claimId = input.id;
  const id = `return-${claimId}`;
  const result = resultText(input);
  const ttlMs = input.ttlMs ?? DAY;
  const fail = (outcome: FleetClaimReturnResult['outcome']): FleetClaimReturnResult => ({ ok: false, outcome, claimId });
  if (!ID.test(claimId) || !ID.test(id) || !ID.test(input.agent) || typeof input.lease !== 'string'
    || !input.lease.trim() || input.lease.length > 128 || [...input.lease].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 7 * DAY || result === null) return fail('invalid-input');
  const board = readFleetBoard(options);
  if (board.state === 'unknown') return fail('unavailable');
  const claim = board.claims.find(c => c.id === claimId);
  if (!claim) {
    const message = board.messages.find(m => m.id === id);
    return message ? { ok: true, outcome: 'already-returned', claimId, message } : fail('not-found');
  }
  const body = fold(`RESULT ${input.blocked !== undefined ? 'BLOCKED' : 'VERIFIED'} ${claim.repo} claim ${claimId} task "${claim.task}": ${result}`);
  if (body.length > 4000) return fail('invalid-input');
  const released = releaseFleetClaim({ id: claimId, agent: input.agent, lease: input.lease }, options);
  if (!released.ok) return fail(released.error === 'duplicate' ? 'unavailable' : released.error);
  const posted = postFleetMessage({ from: input.agent, to: 'all', id, body, ttlMs }, options);
  return posted.ok ? { ok: true, outcome: 'returned', claimId, message: posted.value }
    : { ok: false, outcome: 'released-unposted', claimId, id, body };
}
