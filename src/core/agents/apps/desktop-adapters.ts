/**
 * Desktop-UI fallback adapters. Every step is a desktop operator verb, so its
 * Accessibility, bus-intent, KILL, comms-pause and bundle-allowlist gates apply.
 * `type` fills the focused composer; submitting needs `phm desktop click`.
 */
import { desktopSessions, type DesktopSessionsDeps } from '../../desktop/desktop-sessions.js';
import { runDesktopOperator, type OperatorResult } from '../../desktop/operator.js';
import { OPERATOR_ROSTER } from '../../desktop/operator-policy.js';
import {
  capabilityTable, cleanOutput, invalidInput, refuse, type AgentAppAdapter, type AgentAppProvider, type AgentAppResult, type AgentAppSession,
} from './adapter.js';

export const DESKTOP_AGENT_APP_PROVIDERS = ['devin', 'claude', 'codex', 'grok', 'cursor'] as const satisfies readonly AgentAppProvider[];
const MODEL_IN_APP = 'Choose the model inside the desktop app; the desktop adapter cannot set it.';

const failure = (result: Extract<OperatorResult, { ok: false }>) => refuse(result.code, result.error);

function createDesktopAdapter(provider: (typeof DESKTOP_AGENT_APP_PROVIDERS)[number], deps: DesktopSessionsDeps): AgentAppAdapter {
  const id = `${provider}-desktop`;
  const roster = OPERATOR_ROSTER.find((app) => app.id === provider)!;
  const app = roster.bundleIds[0]!;
  const session = (sessionId: string, output: string | null): AgentAppSession =>
    ({ adapter: id, sessionId, status: 'unknown', model: null, updatedAt: null, output: cleanOutput(output), untrusted: true });

  async function read(window: string | undefined): Promise<AgentAppResult<string | null>> {
    const result = await runDesktopOperator({ verb: 'read', app, ...(window ? { window } : {}) }, deps);
    if (!result.ok) return failure(result);
    return { ok: true, value: typeof result.data['text'] === 'string' ? result.data['text'] : null };
  }

  async function typeInto(window: string | undefined, text: string): Promise<AgentAppResult<AgentAppSession>> {
    const problem = invalidInput({ prompt: text });
    if (problem) return refuse('invalid', problem);
    for (const request of [{ verb: 'focus' as const, app }, { verb: 'type' as const, app, text }]) {
      const result = await runDesktopOperator({ ...request, ...(window ? { window } : {}) }, deps);
      if (!result.ok) return failure(result);
    }
    return { ok: true, value: session(window ?? '', null) };
  }

  return {
    id, provider, surface: 'desktop',
    async describe() {
      const mac = (deps.platform ?? process.platform) === 'darwin';
      return { id, provider, surface: 'desktop', available: mac || deps.surface ? null : false,
        reason: mac || deps.surface ? 'Needs the desktop-operator helper with Accessibility; check phm desktop doctor --json.' : 'Desktop operator runs on macOS.',
        capabilities: capabilityTable({ launchTask: null, listSessions: null, readSession: null, sendMessage: null, readUsage: null }) };
    },
    async launchTask(input) {
      if (input.model !== undefined) return refuse('unsupported', MODEL_IN_APP);
      if (input.cwd !== undefined) return refuse('unsupported', 'The desktop adapter cannot choose a project directory.');
      return typeInto(undefined, input.prompt);
    },
    async listSessions() {
      const listed = await desktopSessions(deps);
      if (!listed.ok) return refuse(listed.code, listed.error);
      return { ok: true, value: listed.sessions.filter((row) => row.rosterApp === provider).map((row) => session(row.windowTitle, null)) };
    },
    async readSession(sessionId) {
      const text = await read(sessionId || undefined);
      return text.ok ? { ok: true, value: session(sessionId, text.value) } : text;
    },
    async sendMessage(sessionId, text) { return typeInto(sessionId || undefined, text); },
    async readUsage(input = {}) {
      const text = await read(input.window);
      return text.ok ? { ok: true, value: { adapter: id, text: cleanOutput(text.value), untrusted: true } } : text;
    },
  };
}

export function createDesktopAgentApps(deps: DesktopSessionsDeps = {}): AgentAppAdapter[] {
  return DESKTOP_AGENT_APP_PROVIDERS.map((provider) => createDesktopAdapter(provider, deps));
}
