/** Keyless oMLX transport. This boundary has no process, credential or dispatch authority. */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PROVIDER_DEFAULT_BASE_URL, validateLocalBaseUrl } from '../run/local-inference.js';

export interface OmlxMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OmlxCompletionRequest {
  model: string;
  messages: readonly OmlxMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface OmlxCompletion {
  model: string;
  text: string;
  finishReason: string;
  /** Missing upstream usage stays unknown, rather than being reported as zero. */
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export interface OmlxRuntimeOptions {
  /** OpenAI API base, including /v1. Defaults to http://127.0.0.1:8000/v1. */
  baseUrl?: string;
  /** Whole request deadline, including body reads; default 30 seconds. */
  timeoutMs?: number;
}

export type OmlxErrorCode = 'invalid-url' | 'invalid-request' | 'http-error' |
  'network-error' | 'timeout' | 'aborted' | 'response-too-large' | 'invalid-response';

/** Value-free errors: upstream bodies, URLs and native error causes may contain secrets. */
export class OmlxRuntimeError extends Error {
  constructor(readonly code: OmlxErrorCode, readonly status?: number) {
    super(`oMLX: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'OmlxRuntimeError';
  }
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const tokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export class OmlxRuntimeClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OmlxRuntimeOptions = {}) {
    const checked = validateLocalBaseUrl(options.baseUrl ?? PROVIDER_DEFAULT_BASE_URL.omlx);
    if (!checked.ok) throw new OmlxRuntimeError('invalid-url');
    this.baseUrl = checked.baseUrl;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new OmlxRuntimeError('invalid-request');
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const body = await this.json('models', undefined, signal);
    if (!record(body) || !Array.isArray(body.data) ||
        !body.data.every((m) => record(m) && typeof m.id === 'string' && m.id.trim() !== '')) {
      throw new OmlxRuntimeError('invalid-response');
    }
    return body.data.map((m: { id: string }) => m.id);
  }

  /** Text chat only. Streaming and tool execution are deliberately outside this adapter. */
  async complete(input: OmlxCompletionRequest, signal?: AbortSignal): Promise<OmlxCompletion> {
    if (!input || typeof input.model !== 'string' || input.model.trim() === '' ||
        !Array.isArray(input.messages) || input.messages.length === 0 ||
        !input.messages.every((m: OmlxMessage) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string') ||
        (input.maxTokens !== undefined && (!tokenCount(input.maxTokens) || input.maxTokens === 0)) ||
        (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2))) {
      throw new OmlxRuntimeError('invalid-request');
    }
    const body = await this.json('chat/completions', {
      model: input.model,
      messages: input.messages.map(({ role, content }) => ({ role, content })),
      stream: false,
      ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    }, signal);
    const choice = record(body) && Array.isArray(body.choices) ? body.choices[0] : null;
    if (!record(body) || typeof body.model !== 'string' || body.model.trim() === '' ||
        !record(choice) || !record(choice.message) || choice.message.role !== 'assistant' ||
        typeof choice.message.content !== 'string' || typeof choice.finish_reason !== 'string' ||
        choice.finish_reason === '' || choice.finish_reason === 'tool_calls' ||
        (choice.message.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length !== 0))) {
      throw new OmlxRuntimeError('invalid-response');
    }
    let usage: OmlxCompletion['usage'] = null;
    if (body.usage !== undefined && body.usage !== null) {
      const u = body.usage;
      if (!record(u) || !tokenCount(u.prompt_tokens) || !tokenCount(u.completion_tokens) || !tokenCount(u.total_tokens)) {
        throw new OmlxRuntimeError('invalid-response');
      }
      usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens };
    }
    return { model: body.model, text: choice.message.content, finishReason: choice.finish_reason, usage };
  }

  private async json(path: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new OmlxRuntimeError('aborted');
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    if (data !== undefined && Buffer.byteLength(data) > MAX_BODY_BYTES) throw new OmlxRuntimeError('invalid-request');
    const url = new URL(`${this.baseUrl}/${path}`);
    // Validation pins localhost to loopback. Native HTTP ignores proxy settings
    // and does not follow redirects, including loopback redirects.
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: OmlxRuntimeError, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) {
          req.destroy();
          reject(error);
        } else resolve(value);
      };
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: data === undefined ? 'GET' : 'POST',
        agent: false,
        headers: {
          Accept: 'application/json',
          ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
        },
      }, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.destroy();
          finish(new OmlxRuntimeError('http-error', status));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            res.destroy();
            finish(new OmlxRuntimeError('response-too-large'));
          } else chunks.push(chunk);
        });
        res.on('error', () => finish(new OmlxRuntimeError('network-error')));
        res.on('end', () => {
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(new OmlxRuntimeError('invalid-response')); }
        });
      });
      const abort = () => finish(new OmlxRuntimeError('aborted'));
      const timer = setTimeout(() => finish(new OmlxRuntimeError('timeout')), this.timeoutMs);
      req.on('error', () => finish(new OmlxRuntimeError('network-error')));
      signal?.addEventListener('abort', abort, { once: true });
      // Covers cancellation racing request creation/listener registration.
      if (signal?.aborted) abort();
      if (!settled) req.end(data);
    });
  }
}
