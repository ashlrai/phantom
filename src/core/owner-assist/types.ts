import type { VerseEvent, VerseSeat, VerseSession } from '../verse/types.js';
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
export interface OwnerAssistSnapshot {
  scope: 'owner';
  concurrency: 1;
  preferences: OwnerAssistPreferences;
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
export type OwnerAssistHandoff = Pick<QueueJob, 'id' | 'repo' | 'scope' | 'acceptance'> & { tier: 'fast' | 'mid' | 'work' | 'frontier' };
export interface OwnerAssistHandoffReceipt extends OwnerAssistHandoff {
  fleetJobId: string;
  status: 'SUBMITTED' | 'QUEUED' | 'RUNNING' | 'FINISHED' | 'PR-OPEN' | 'MERGED' | 'REJECTED' | 'UNOBSERVED';
  prUrl?: string;
}
