import { spawn } from 'node:child_process';

export type AcpModelStep = { kind: 'set'; configId: string; value: string }
  | { kind: 'done' } | { kind: 'unplannable'; reason: string };
export interface AcpSeatOptions {
  command: string; args: string[]; cwd: string; prompt: string; model: string;
  qualifyModel: (model: string) => boolean | Promise<boolean>;
  planModelStep?: (target: string, configOptions: unknown) => AcpModelStep;
  permission?: 'read-only' | 'allow'; timeoutMs: number; signal?: AbortSignal;
}
export interface AcpSeatDeps { spawn?: typeof spawn; env?: NodeJS.ProcessEnv }
export interface AcpSeatResult {
  ok: boolean; code: string; message?: string; stopReason?: string; text: string; sessionId?: string;
}
type Json = Record<string, unknown>;
const record = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const LIMIT = 1024 * 1024;

export async function runAcpSeatTurn(opts: AcpSeatOptions, deps: AcpSeatDeps = {}): Promise<AcpSeatResult> {
  let qualified = false;
  try { qualified = /^[A-Za-z0-9._:-]{1,120}$/.test(opts.model ?? '') && await opts.qualifyModel(opts.model) === true; } catch { /* fail closed */ }
  if (!qualified) return { ok: false, code: 'model-unqualified', message: 'Model is not qualified; no paid fallback.', text: '' };
  if (opts.signal?.aborted) return { ok: false, code: 'aborted', text: '' };
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    let sessionId: string | undefined;
    let text = '', buffer = '', sequence = 0, settled = false;
    const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
    const send = (message: Json) => {
      if (!settled && child.stdin?.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const finish = (code: string, stopReason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      for (const waiter of pending.values()) waiter.reject(new Error('ACP closed'));
      pending.clear();
      child.kill('SIGKILL');
      resolve({ ok: code === 'ok', code, text, sessionId, stopReason });
    };
    const cancel = (code: string) => {
      if (sessionId) send({ method: 'session/cancel', params: { sessionId } });
      // Flush cancellation before terminating the process.
      child.stdin?.end(() => finish(code));
      setImmediate(() => finish(code));
    };
    const abort = () => cancel('aborted');
    const timer = setTimeout(() => cancel('timeout'), Math.max(1, opts.timeoutMs));
    try { child = (deps.spawn ?? spawn)(opts.command, opts.args, { cwd: opts.cwd, env: deps.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { clearTimeout(timer); resolve({ ok: false, code: 'spawn-error', text }); return; }
    child.on('error', () => finish('spawn-error'));
    child.on('close', () => finish('agent-exited'));
    child.stdin?.on('error', () => finish('transport-error'));
    child.stderr?.resume();
    opts.signal?.addEventListener('abort', abort, { once: true });
    const request = (method: string, params: Json): Promise<Json> => new Promise((resolve, reject) => {
      if (settled) { reject(new Error('ACP closed')); return; }
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > LIMIT) { finish('buffer-limit'); return; }
      let newline: number;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: Json;
        try { message = record(JSON.parse(line)); } catch { finish('protocol-error'); return; }
        const params = record(message.params);
        if (typeof message.method === 'string' && message.id !== undefined) {
          if (message.method !== 'session/request_permission') {
            send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
          } else {
            const allow = opts.permission === 'allow' || ['read', 'search', 'fetch', 'think'].includes(String(record(params.toolCall).kind));
            const options = Array.isArray(params.options) ? params.options.map(record) : [];
            const option = [allow ? 'allow_once' : 'reject_once', allow ? 'allow_always' : 'reject_always']
              .map((kind) => options.find((o) => o.kind === kind && typeof o.optionId === 'string')).find(Boolean);
            send({ id: message.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
          }
        } else if (message.method === 'session/update' && params.sessionId === sessionId) {
          const update = record(params.update), content = record(update.content);
          if (update.sessionUpdate === 'agent_message_chunk' && content.type === 'text' && typeof content.text === 'string') {
            if (text.length + content.text.length > LIMIT) { finish('buffer-limit'); return; }
            text += content.text;
          }
        } else if (typeof message.id === 'number') {
          const waiter = pending.get(message.id); pending.delete(message.id);
          if (message.error) waiter?.reject(new Error('ACP request failed'));
          else waiter?.resolve(record(message.result));
        }
      }
    });
    void (async () => {
      try {
        await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
        const session = await request('session/new', { cwd: opts.cwd, mcpServers: [] });
        if (typeof session.sessionId !== 'string' || !session.sessionId) throw new Error('Missing session');
        sessionId = session.sessionId;
        const config = (Array.isArray(session.configOptions) ? session.configOptions : []).map(record)
          .find((option) => option.category === 'model' || option.id === 'model');
        if (config && opts.planModelStep) {
          let configOptions = session.configOptions;
          for (let steps = 0; ; steps++) {
            const step = opts.planModelStep(opts.model, configOptions);
            if (step.kind === 'done') break;
            if (step.kind === 'unplannable' || steps >= 4) { finish('model-unavailable'); return; }
            const answer = await request('session/set_config_option', { sessionId, configId: step.configId, value: step.value });
            configOptions = answer.configOptions;
          }
        } else if (config) {
          const offered = Array.isArray(config.options) ? config.options.map(record) : [];
          if (!offered.some((option) => option.value === opts.model)) { finish('model-unavailable'); return; }
          if (config.currentValue !== opts.model) {
            const answer = await request('session/set_config_option', { sessionId, configId: config.id, value: opts.model });
            const updated = (Array.isArray(answer.configOptions) ? answer.configOptions : []).map(record).find((option) => option.id === config.id);
            if (updated?.currentValue !== opts.model) { finish('model-unavailable'); return; }
          }
        }
        const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: opts.prompt }] });
        finish('ok', typeof result.stopReason === 'string' ? result.stopReason : undefined);
      } catch { finish('protocol-error'); }
    })();
    if (opts.signal?.aborted) abort();
  });
}
