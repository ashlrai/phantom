/**
 * `ashlr fleet dot-handoff [--json]` — offline, read-only evidence summary for
 * handing work to Mason's personal OpenAI Dot (and back). Prints what official
 * OpenAI documentation establishes, what stays unverified, the honest transport
 * boundary (owner-only outbox plus a separately approved teammate transport), and the next concrete
 * handoff step. No network, no filesystem reads, no account access, no sends.
 * Guide: docs/DOT-HANDOFF.md.
 */

const USAGE = 'Usage: ashlr fleet dot-handoff [--json]';

const DOC = 'https://learn.chatgpt.com/docs/dots';
const HELP = 'https://help.openai.com/en/articles/20001530-getting-started-with-your-dot';
const CHANNELS = 'https://learn.chatgpt.com/docs/dots/channels';
const TASKS = 'https://learn.chatgpt.com/docs/dots/tasks-and-memory';
const CONTROLS = 'https://learn.chatgpt.com/docs/dots/controls';
const COMPUTERS = 'https://learn.chatgpt.com/docs/dots/computers-and-apps';
const FAQ = 'https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs';
const WS_TRIGGER = 'https://learn.chatgpt.com/workspace-agents/trigger-runs';
const WS_AUTH = 'https://developers.openai.com/workspace-agents/authentication';
const MCP_EVENTS = 'https://developers.openai.com/plugins/build/mcp-events';
const PLUGIN_AUTH = 'https://developers.openai.com/plugins/build/auth';

type Evidence = 'documented' | 'unverified' | 'separate-product';
interface Capability {
  id: string;
  status: Evidence;
  claim: string;
  sources: string[];
}

const CAPABILITIES: Capability[] = [
  {
    id: 'dot-product',
    status: 'documented',
    claim: 'A personal dot is an always-on ChatGPT agent with its own cloud computer and browser; it works between conversations and can pause/wake itself. One dot per eligible member.',
    sources: [DOC, HELP],
  },
  {
    id: 'task-handoff-to-dot',
    status: 'documented',
    claim: 'Tasks reach a dot conversationally: ChatGPT mobile/desktop app (not mobile web), voice call, Slack, Teams, or texting. Texting is a US Pro beta, one-to-one iMessage/RCS: only the owner can text the dot, the dot cannot join group texts or text anyone else, and it cannot initiate calls.',
    sources: [CHANNELS, HELP],
  },
  {
    id: 'delegation-from-dot',
    status: 'documented',
    claim: 'A dot delegates to ChatGPT Work or Codex: local Work/Codex tasks need the one connected personal computer online with the ChatGPT app open; cloud coding tasks need a Codex cloud environment pre-created in Codex. Delegated tasks appear under the dot\'s Activity.',
    sources: [TASKS, COMPUTERS, HELP],
  },
  {
    id: 'proactive-research',
    status: 'documented',
    claim: 'Proactive research is read-only: it cannot send messages to other people, change content through plugins, or control a browser or computer. Scheduled runs and proactive updates appear in the conversation; schedules need a saved task with timezone, end condition and notification destination.',
    sources: [TASKS, FAQ, CONTROLS],
  },
  {
    id: 'approvals-and-controls',
    status: 'documented',
    claim: 'An automatic action review gates account-affecting or sharing actions; custom rules offer four modes (act, act-on-request, ask-first, hand-off). Sensitive actions (passwords, payments, some deletes) are handed to the user. Pause, stopping a delegated task and canceling a schedule are separate controls.',
    sources: [CONTROLS, FAQ],
  },
  {
    id: 'usage-and-availability',
    status: 'documented',
    claim: 'Dot conversations do not count toward ChatGPT usage limits; Work/Codex tasks it starts count against those products. Plan includes a deeper-work allowance with extended limits the first month. Availability: Pro 100/200/500 (18+, outside EEA/UK/CH), Business Premium worldwide rollout, Enterprise admin-enabled and off by default; not for UAE-residency workspaces. Enterprise preview billing starts 2026-11-18; earlier preview is free.',
    sources: [DOC, HELP],
  },
  {
    id: 'model-identity',
    status: 'unverified',
    claim: 'Docs say dots are powered by the GPT-6 family and are expanding to include GPT-6.1 Terra, with different models for different parts of the work. The exact model behind any given task is not documented; do not assume or pin a model name.',
    sources: [DOC],
  },
  {
    id: 'personal-dot-api',
    status: 'unverified',
    claim: 'No official source documents an API to create a personal dot, send it messages, subscribe to its events, poll its tasks, or read its output. All personal-dot surfaces are conversational or account UI.',
    sources: [DOC, CHANNELS, HELP],
  },
  {
    id: 'workspace-agents-api',
    status: 'separate-product',
    claim: 'The Workspace Agents API is real but separate: POST .../workspace_agents/{id}/trigger returns 202 with a conversation_url; beta run-status polling exists; agent responses cannot be retrieved through the API. It triggers published workspace agents, not a personal dot, and needs its own workspace agent access token.',
    sources: [WS_TRIGGER, WS_AUTH],
  },
  {
    id: 'plugin-mcp-events',
    status: 'separate-product',
    claim: 'An authenticated ChatGPT plugin can expose MCP 2.0 events (events/list, subscribe, unsubscribe) so ChatGPT receives signed deliveries on a verified public HTTPS callback; user OAuth 2.1 with S256 PKCE is required. This is an inbound surface Phantom could serve, not a way to drive a dot. A delivery acknowledges receipt, not completed work.',
    sources: [MCP_EVENTS, PLUGIN_AUTH],
  },
];

const LIMITS = [
  'One connected personal computer at a time; it must stay online with the ChatGPT app open for local tasks.',
  'Dot texting is one-to-one between owner and dot (US Pro beta); no group texts, no third-party texters, no dot-initiated calls.',
  'A dot cannot send messages to other people through proactive research; follow-up actions need the applicable permissions.',
  'No documented API retrieves a personal dot\'s response; the Workspace Agents API cannot return agent responses either.',
  'Cloud browser sessions are separate from the Mac\'s signed-in sessions; local skills require the connected computer.',
];

export const DOT_HANDOFF_SUMMARY = {
  schema: 'fleet.dot-handoff.v1',
  observedAt: '2026-11-04',
  repositoryObservedAt: '2026-11-08',
  readOnly: true,
  offline: true,
  guide: 'docs/DOT-HANDOFF.md',
  subject: 'OpenAI Dot (personal always-on ChatGPT agent) as a fleet counterpart',
  masonObservation:
    'Mason reports using a personal dot (order t1635u, 2026-11-04). That is a local observation, not documentation: his account eligibility, plan, region and enabled features are unverified from this repo and must be checked in the actual account.',
  busContract: {
    provider: 'openai-dot',
    status: 'recognized-label-only',
    source: 'src/core/agents/bus-v2-schema.ts',
    note: 'agent-bus.v2 lists openai-dot as a provider label for routing. It is not an authenticated identity, and bus claims grant no execution authority.',
  },
  a2aSchema: {
    status: 'configuration-only',
    source: 'src/core/agents/a2a-schema.ts',
    note: 'Validates counterpart shape (localOptIn, remoteOptInEvidence, channel email|slack|imessage, scope). Disabled by default; no runtime, transport or send path is wired.',
  },
  transport: {
    phantomToDot: 'unverified',
    reason:
      'The owner outbox remains self-only. A separate approved teammate transport exists in src/core/comms/imessage-teammate-transport.ts and is used by the teammate responder. It requires macOS, enabled/unpaused comms, a non-owner allowlisted handle, local team/send-policy approval, and a fresh config check. This offline command does not inspect those prerequisites or prove an installed responder, successful delivery, or remote Dot acceptance.',
    teammateTransport: 'available-in-source',
    hostQualification: 'not-observed',
    unsupportedStep: 'needs-you',
    needsYou: 'ashlr fleet needs',
    needsYouFile: 'NEEDS-MASON.md under the runs dir',
  },
  capabilities: CAPABILITIES,
  limits: LIMITS,
  nextHandoffStep:
    'Use the bounded template and check host readiness with phm imessage doctor --json. A configured, authorized teammate exchange can use the existing responder; phm imessage respond --apply is a sending action, not a diagnostic. Preserve the handoff-id and verify exact delivery and returned results. If the route is unconfigured, unsupported or lacks approval, use needs-you rather than changing permissions. The generic a2a configuration does not itself establish transport.',
  taskTemplate: {
    'handoff-id': 'stable local id, e.g. dot-handoff-20261104-01',
    goal: 'one sentence: the outcome wanted',
    repo: 'owner/name only',
    paths: 'exact repo-relative paths to read or change',
    acceptance: 'observable checks: named tests, files, or evidence links',
    privacy: 'local-only: no credentials, tokens, personal text or identifiers; dot cloud computer is outside the trust boundary',
    correlation: 'dot echoes handoff-id in its first reply and final result; report exact head SHA and evidence links',
    authority: 'proposal only: no merge, push, spend or permission change implied',
  },
} as const;

export async function cmdFleetDotHandoff(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${USAGE}\nOffline read-only evidence summary for handing work to a personal OpenAI Dot.\nGuide: docs/DOT-HANDOFF.md. Observed ${DOT_HANDOFF_SUMMARY.observedAt}.`);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const s = DOT_HANDOFF_SUMMARY;
  if (args[0] === '--json') {
    console.log(JSON.stringify(s));
    return 0;
  }
  const lines = [
    `Dot handoff evidence (observed ${s.observedAt}; offline, read-only) — ${s.guide}`,
    `Mason observation: ${s.masonObservation}`,
    `Bus contract: ${s.busContract.provider} is a ${s.busContract.status} (${s.busContract.source}).`,
    `A2A schema: ${s.a2aSchema.status} (${s.a2aSchema.source}).`,
    `Transport Phantom→dot: ${s.transport.phantomToDot} — ${s.transport.reason}`,
    `Unsupported steps route to ${s.transport.unsupportedStep}: ${s.transport.needsYou}.`,
    'Capabilities:',
    ...s.capabilities.map(c => `  [${c.status}] ${c.id}: ${c.claim}`),
    'Limits:',
    ...s.limits.map(l => `  - ${l}`),
    `Next step: ${s.nextHandoffStep}`,
  ];
  console.log(lines.join('\n'));
  return 0;
}
