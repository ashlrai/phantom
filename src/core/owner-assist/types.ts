import type { VerseEvent, VerseSeat, VerseSession, VerseTurnResponse } from '../verse/types.js';
import type { VerseAgentPendingConfirmation } from '../verse/verse-mcp-types.js';
import type { QueueJob } from '../queue/schema.js';

/** Wire contracts: docs/contracts/CONTRACT-OWNER-ASSIST.md. */
export interface OwnerAssistPreferences {
  callsign: string;
  preference: 'auto' | 'local' | 'api';
  omlxPort?: number;
}
export interface OwnerAssistTurn {
  text: string;
  projectPath: string;
  extraRoots?: string[];
  sessionId?: string;
  preference?: OwnerAssistPreferences['preference'];
  tier: 'fast' | 'work' | 'frontier';
  seatId?: string;
  model?: string;
}
/**
 * Which model answered and why — the routing transparency record the owner
 * sees for each send. `fellBack` is the honesty flag: the picked class differs
 * from the class the preference/tier would have chosen (explicit seat, local
 * and api choices never fall back; they are refused instead).
 */
export interface OwnerAssistRouting {
  preference: 'auto' | 'local' | 'api';
  tier: 'fast' | 'work' | 'frontier';
  /** The seat class that actually answered. */
  class: 'local' | 'api';
  seatId: string;
  seatLabel: string;
  model: string;
  fellBack: boolean;
  /** One human sentence, e.g. 'Non-trivial task on the best available API seat.' */
  reason: string;
  /** ISO time of the routing decision. */
  at: string;
}
export interface OwnerAssistSnapshot {
  scope: 'owner';
  concurrency: 1;
  preferences: OwnerAssistPreferences;
  /** The persisted conversation to reopen after a restart; absent when that session no longer exists. */
  resumeSessionId?: string;
  /** Routing record per session id, for 'which model answered and why'. */
  routing: Record<string, OwnerAssistRouting>;
  sessions: VerseSession[];
  seats: VerseSeat[];
  memory: string;
  memorySanitized?: boolean;
}
export interface OwnerAssistDetail {
  session: VerseSession;
  events: VerseEvent[];
  pending: VerseAgentPendingConfirmation[];
}
export type OwnerAssistTurnResponse = VerseTurnResponse & { routing: OwnerAssistRouting };
export type OwnerAssistHandoff = Pick<QueueJob, 'id' | 'repo' | 'scope' | 'acceptance'> & { tier: 'fast' | 'mid' | 'work' | 'frontier'; sessionId?: string };
export interface OwnerAssistHandoffReceipt extends OwnerAssistHandoff {
  fleetJobId: string;
  status: 'SUBMITTED' | 'QUEUED' | 'RUNNING' | 'FINISHED' | 'PR-OPEN' | 'MERGED' | 'REJECTED' | 'UNOBSERVED';
  prUrl?: string;
  /** Title of the owner session the handoff was sent from, when linked. */
  sourceTitle?: string;
  /** ISO time of the first accepted submission. */
  submittedAt?: string;
}
