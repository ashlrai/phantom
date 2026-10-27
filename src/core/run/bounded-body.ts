/**
 * Bounded response-body reads for local probes.
 *
 * A local /models or /api/tags reply is small. This stops the stream at a
 * fixed cap so an oversized or endless body is never buffered. Kept apart
 * from the local-inference probe so the cap can be shared by provider
 * liveness checks without pulling the probe into their import graph.
 */
export const LOCAL_PROBE_MAX_BODY_BYTES = 256 * 1024;

/**
 * Stream the body and stop as soon as it passes `max` bytes, so a huge or
 * endless reply never buffers past the cap. Null when over the cap or unreadable.
 */
export async function readCappedBody(res: Response, max: number, controller?: AbortController): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => {}); controller?.abort(); return null; }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); controller?.abort(); return null; }
    chunks.push(value);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { return null; }
}

/**
 * JSON from a local probe response, bounded. A real fetch body is streamed and
 * stopped at `max` bytes. A stub with no body (tests) may implement `json()`;
 * that value is still rejected when its serialized form exceeds `max`.
 */
export async function readJsonBounded(
  res: Response,
  max: number = LOCAL_PROBE_MAX_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'too-large' | 'invalid' }> {
  try {
    let text: string | null;
    if (res.body) {
      text = await readCappedBody(res, max);
    } else {
      const value = await res.json();
      text = JSON.stringify(value);
      if (Buffer.byteLength(text) > max) return { ok: false, reason: 'too-large' };
    }
    if (text === null) return { ok: false, reason: 'too-large' };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
