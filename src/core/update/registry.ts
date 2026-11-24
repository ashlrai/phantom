/** Public registry reads never resolve npm credentials or follow redirects. */
export async function registryBytes(url: string, maximum: number): Promise<Buffer> {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error('Registry download failed');
  return boundedBody(response, maximum);
}
async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw new Error('Registry body unavailable');
  const reader = response.body.getReader();
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > maximum) throw new Error('Registry response is too large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export async function probeNpmRegistry(packageName: string): Promise<{ reachable: boolean; metadata: unknown }> {
  let reachable = false;
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    reachable = response.ok;
    return { reachable, metadata: reachable ? JSON.parse((await boundedBody(response, 1024 * 1024)).toString('utf8')) : null };
  } catch { return { reachable, metadata: null }; }
}
