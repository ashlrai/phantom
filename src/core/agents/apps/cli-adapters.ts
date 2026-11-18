/**
 * CLI agent app adapters (prompt on stdin): `codex exec --json -` / `codex exec
 * resume <thread>`, `claude -p --output-format json` / `--resume <id>`. Devin is a
 * stub until the ACP seat (#6550) lands. KILL stops launch and send (fail closed).
 */
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { killSwitchOn } from '../../sandbox/policy.js';
import {
  capabilityTable, cleanOutput, defaultAgentAppLedgerPath, invalidInput, readAgentAppLedger, refuse, sessionFromRow,
  stopEngaged, upsertAgentAppLedger, type AgentAppAdapter, type AgentAppResult, type AgentAppSession,
} from './adapter.js';

export interface CliRunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; missing: boolean }
export type CliRunner = (command: string, args: readonly string[], opts: { stdin: string; cwd?: string; timeoutMs: number }) => Promise<CliRunResult>;

export interface CliAdapterDeps {
  /** Absolute binary path per CLI; default is the first executable on PATH. */
  commands?: Partial<Record<'codex' | 'claude' | 'devin', string>>;
  run?: CliRunner; killed?: () => boolean; ledgerPath?: string; now?: () => Date; timeoutMs?: number;
}

const OUTPUT_CAP = 2_000_000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const defaultCliRunner: CliRunner = (command, args, opts) => new Promise((resolve) => {
  let stdout = '', stderr = '', timedOut = false;
  const child = spawn(command, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, opts.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8'); });
  child.on('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, timedOut, missing: error.code === 'ENOENT' }); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, missing: false }); });
  child.stdin.on('error', () => undefined).end(opts.stdin);
});

export function findOnPath(name: string, path = process.env['PATH'] ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    try { accessSync(join(dir, name), fsConstants.X_OK); return join(dir, name); } catch { /* next */ }
  }
  return null;
}

interface Turn { sessionId: string | null; output: string | null; failed: string | null }
interface CliSpec {
  provider: 'codex' | 'claude'; launchArgs(input: { model?: string; cwd?: string }): string[];
  resumeArgs(sessionId: string): string[]; parse(stdout: string): Turn;
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout.split('\n').flatMap((line) => {
    try { const v = JSON.parse(line) as unknown; return v && typeof v === 'object' ? [v as Record<string, unknown>] : []; } catch { return []; }
  });
}

const CODEX: CliSpec = {
  provider: 'codex',
  launchArgs: ({ model, cwd }) => ['exec', '--json', '--skip-git-repo-check', ...(model ? ['--model', model] : []), ...(cwd ? ['--cd', cwd] : []), '-'],
  resumeArgs: (id) => ['exec', 'resume', id, '--json', '--skip-git-repo-check', '-'],
  parse(stdout) {
    const turn: Turn = { sessionId: null, output: null, failed: null };
    for (const event of jsonLines(stdout)) {
      const item = event['item'] as Record<string, unknown> | undefined;
      if (event['type'] === 'thread.started' && typeof event['thread_id'] === 'string') turn.sessionId = event['thread_id'];
      else if (event['type'] === 'item.completed' && item?.['type'] === 'agent_message' && typeof item['text'] === 'string') turn.output = item['text'];
      else if (event['type'] === 'turn.failed' || event['type'] === 'error') turn.failed = 'codex reported a failed turn';
    }
    return turn;
  },
};

const CLAUDE: CliSpec = {
  provider: 'claude',
  launchArgs: ({ model }) => ['-p', '--output-format', 'json', ...(model ? ['--model', model] : [])],
  resumeArgs: (id) => ['-p', '--resume', id, '--output-format', 'json'],
  parse(stdout) {
    const event = jsonLines(stdout).at(-1) ?? jsonLines(stdout.replace(/\n/g, ' ')).at(-1) ?? {};
    return {
      sessionId: typeof event['session_id'] === 'string' ? event['session_id'] : null,
      output: typeof event['result'] === 'string' ? event['result'] : null,
      failed: event['is_error'] === true ? 'claude reported an error result' : null,
    };
  },
};

function createCliAdapter(spec: CliSpec, deps: CliAdapterDeps): AgentAppAdapter {
  const id = `${spec.provider}-cli`;
  const ledger = deps.ledgerPath ?? defaultAgentAppLedgerPath();
  const binary = (): string | null => deps.commands?.[spec.provider] ?? findOnPath(spec.provider);
  const unsupportedUsage = `${spec.provider} CLI has no documented usage command; read usage through ${spec.provider}-desktop`;

  async function turn(args: string[], prompt: string, cwd: string | undefined, model: string | null, known: string | null): Promise<AgentAppResult<AgentAppSession>> {
    if (stopEngaged(deps.killed ?? killSwitchOn)) return refuse('killed', 'The fleet KILL switch is on. Agent app launches are stopped.');
    const command = binary();
    if (!command) return refuse('unavailable', `${spec.provider} is not on PATH`);
    const result = await (deps.run ?? defaultCliRunner)(command, args, { stdin: prompt, cwd, timeoutMs: deps.timeoutMs ?? 30 * 60_000 });
    if (result.missing) return refuse('unavailable', `${spec.provider} is not on PATH`);
    if (result.timedOut) return refuse('failed', `${spec.provider} timed out`);
    const parsed = spec.parse(result.stdout);
    const sessionId = parsed.sessionId ?? known;
    if (!sessionId || !SESSION_ID.test(sessionId)) return refuse('failed', `${spec.provider} returned no session id (exit ${result.code ?? 'signal'})`);
    const status = result.code === 0 && !parsed.failed ? 'idle' : 'failed';
    const row = { adapter: id, sessionId, status, model, updatedAt: (deps.now ?? (() => new Date()))().toISOString(), output: cleanOutput(parsed.output) } as const;
    upsertAgentAppLedger(ledger, row);
    return { ok: true, value: sessionFromRow(row) };
  }

  return {
    id, provider: spec.provider, surface: 'cli',
    async describe() {
      const found = binary() !== null;
      return { id, provider: spec.provider, surface: 'cli', available: found, reason: found ? null : `${spec.provider} is not on PATH`,
        capabilities: capabilityTable({ launchTask: null, listSessions: null, readSession: null, sendMessage: null, readUsage: unsupportedUsage }) };
    },
    async launchTask(input) {
      const problem = invalidInput(input);
      return problem ? refuse('invalid', problem) : turn(spec.launchArgs(input), input.prompt, input.cwd, input.model ?? null, null);
    },
    async listSessions() {
      return { ok: true, value: readAgentAppLedger(ledger).filter((row) => row.adapter === id).slice(0, 50).map(sessionFromRow) };
    },
    async readSession(sessionId) {
      const row = readAgentAppLedger(ledger).find((r) => r.adapter === id && r.sessionId === sessionId);
      return row ? { ok: true, value: sessionFromRow(row) } : refuse('not_found', 'No session with that id was started through this adapter.');
    },
    async sendMessage(sessionId, text) {
      if (!SESSION_ID.test(sessionId)) return refuse('invalid', 'invalid session id');
      const problem = invalidInput({ prompt: text });
      if (problem) return refuse('invalid', problem);
      const prior = readAgentAppLedger(ledger).find((r) => r.adapter === id && r.sessionId === sessionId);
      return turn(spec.resumeArgs(sessionId), text, undefined, prior?.model ?? null, sessionId);
    },
    async readUsage() { return refuse('unsupported', unsupportedUsage); },
  };
}

const DEVIN_STUB = 'The Devin ACP seat (src/core/devin/acp-seat.ts, #6550) is not on master yet; use devin-desktop.';

function createDevinCliStub(deps: CliAdapterDeps): AgentAppAdapter {
  const no = async () => refuse('unsupported', DEVIN_STUB);
  return {
    id: 'devin-cli', provider: 'devin', surface: 'cli',
    async describe() {
      const found = (deps.commands?.devin ?? findOnPath('devin')) !== null;
      return { id: 'devin-cli', provider: 'devin', surface: 'cli', available: false, reason: found ? DEVIN_STUB : 'devin is not on PATH', capabilities: capabilityTable({}) };
    },
    launchTask: no, listSessions: no, readSession: no, sendMessage: no, readUsage: no,
  };
}

export function createCliAgentApps(deps: CliAdapterDeps = {}): AgentAppAdapter[] {
  return [createCliAdapter(CODEX, deps), createCliAdapter(CLAUDE, deps), createDevinCliStub(deps)];
}
