import { apiGet, apiPost } from '../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../data/auth-store.js';
import type { OwnerAssistDetail, OwnerAssistHandoff, OwnerAssistPreferences, OwnerAssistSnapshot, OwnerAssistTurn } from '../../../core/owner-assist/types.js';
import type { VerseTurnResponse } from '../../../core/verse/types.js';
import type { OwnerAssistHandoffReceipt } from '../../../core/owner-assist/types.js';

const base = '/api/verse/owner-assist';
async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new Error('Unlock actions with the mutation token to continue.');
  const result = await apiPost<T>(base + path, body, token);
  touchMutationHold();
  return result;
}
export const ownerAssistApi = {
  snapshot: (signal?: AbortSignal) => apiGet<OwnerAssistSnapshot>(base, signal),
  detail: (id: string, signal?: AbortSignal) => apiGet<OwnerAssistDetail>(`${base}/sessions/${encodeURIComponent(id)}`, signal),
  send: (turn: OwnerAssistTurn) => post<VerseTurnResponse>('/turns', turn),
  cancel: (id: string) => post(`/sessions/${encodeURIComponent(id)}/cancel`, {}),
  configure: (preferences: OwnerAssistPreferences) => post('/preferences', preferences),
  remember: (text: string) => post('/memory', { text }),
  handoff: (job: OwnerAssistHandoff) => post<OwnerAssistHandoffReceipt>('/handoffs', job),
  handoffs: (signal?: AbortSignal) => apiGet<OwnerAssistHandoffReceipt[]>(base + '/handoffs', signal),
};
