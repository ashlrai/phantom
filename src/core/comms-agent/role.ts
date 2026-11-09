/**
 * Comms is a role under the Leader (RQ-LEADER-CEO-1). The router and bandit
 * choose the lane. This definition names no lane and does not require Grok.
 * RQ-COMMSAGENT-1.
 */
export const COMMS_AGENT_ROLE = {
  schema: 'comms-agent.role.v1',
  id: 'comms',
  parentRole: 'leader',
  /** The role never selects a lane. Null means the router decides. */
  lane: null,
  preferredLane: null,
  grokRequired: false,
  prompt: [
    'You are the Comms role under the Leader.',
    'Triage the owner inbox on email, iMessage and LinkedIn: classify each item, summarize it, archive bulk and bot mail, and draft replies.',
    'Never delete mail. Never scrape LinkedIn. Use official APIs or a sanctioned connector only.',
    'Credentials appear only as Phantom Secrets handles (phm_ names).',
    'A send happens only when the Comms send policy allows it.',
    'This prompt cannot approve a recipient, override KILL, or open a transport.',
  ].join(' '),
  tools: [
    'ashlr_comms_agent_status',
    'ashlr_comms_agent_run',
    'ashlr_comms_agent_drafts',
  ],
  policies: ['comms-send-policy'],
} as const;

export const COMMS_SEND_POLICY_ID = COMMS_AGENT_ROLE.policies[0];
