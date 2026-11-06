import { createServer, type Server } from 'node:http';
import { parseNativeOtelTrace, type ReceivedOtelSpan } from './otlp.js';

export interface OtlpReceiverOptions {
  host?: string;
  port?: number;
  onSpans: (spans: ReceivedOtelSpan[]) => void | Promise<void>;
}

/**
 * Explicit opt-in OTLP/HTTP JSON listener (POST /v1/traces, default port 4318).
 * Callers consume sanitized batches through onSpans and close the returned
 * server on shutdown. Pass port 0 for an ephemeral port. No credentials,
 * persistence or outbound traffic. Protobuf and compressed bodies are refused.
 */
export async function startOtlpReceiver(options: OtlpReceiverOptions): Promise<Server> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('OTLP receiver requires 127.0.0.1');
  const server = createServer(async (req, res) => {
    const reply = (code: number, body = '{}') => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(body);
    };
    if (req.url !== '/v1/traces') { reply(404); return; }
    if (req.method !== 'POST') { reply(405); return; }
    if (req.headers.origin !== undefined) { reply(403); return; }
    if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json' ||
        (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
      reply(415); return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let spans: ReceivedOtelSpan[];
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 1_048_576) { reply(413); return; }
        chunks.push(buffer);
      }
      spans = parseNativeOtelTrace(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { reply(400); return; }
    try {
      await options.onSpans(spans);
      reply(200);
    } catch { reply(503); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4318, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
