/** Local completion notification, never an authorization or dispatch command. */
export const AGENT_DECISION_EVENT = 'ashlr:agent-decision';
export interface AgentDecisionDetail {
  id: string;
  decision: 'approve' | 'deny';
}
export function emitAgentDecision(id: string, decision: AgentDecisionDetail['decision']): void {
  window.dispatchEvent(new CustomEvent<AgentDecisionDetail>(AGENT_DECISION_EVENT, {
    detail: { id, decision },
  }));
}
