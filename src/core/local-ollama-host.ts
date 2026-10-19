/**
 * Loopback-only reading of OLLAMA_HOST for the two code paths that talk to a
 * local Ollama with fixed addresses (the knowledge index builder, which sends
 * repo chunks to the embedding model, and the model manager's liveness probe).
 *
 * Those paths were pinned to http://localhost:11434 / http://127.0.0.1:11434 on
 * purpose, so repo content and model metadata cannot leave the machine. This
 * keeps that guarantee and only lets a user who runs Ollama on a different
 * LOCAL port (or loopback address) say so through the variable Ollama itself
 * reads. A value that names any other host is ignored and the default is used;
 * nothing here makes a remote Ollama reachable.
 *
 * Accepted forms (same as Ollama's): `host`, `host:port`, `:port` and a full
 * `http(s)://host[:port]` URL, with or without trailing slashes. A missing port
 * means 11434.
 */

export const DEFAULT_LOCAL_OLLAMA_PORT = 11434;

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '[::1]' || h === '::1') return true;
  if (!LOOPBACK_V4.test(h)) return false;
  return h.split('.').every((part) => Number(part) <= 255);
}

/**
 * The Ollama origin a local-only path may use: OLLAMA_HOST when it names a
 * loopback host, else `fallback` (default `http://localhost:11434`). No trailing
 * slash, no path.
 */
export function localOllamaBase(
  env: Record<string, string | undefined> = process.env,
  fallback = `http://localhost:${DEFAULT_LOCAL_OLLAMA_PORT}`,
): string {
  const raw = (env['OLLAMA_HOST'] ?? '').trim().replace(/\/+$/, '');
  if (!raw) return fallback;

  let scheme = 'http';
  let rest = raw;
  const m = /^(https?):\/\/(.*)$/i.exec(raw);
  if (m) {
    scheme = m[1]!.toLowerCase();
    rest = m[2]!;
  }
  if (rest.includes('/') || rest.includes('@') || rest.includes('?') || rest.includes('#')) return fallback;

  let host = rest;
  let port = String(DEFAULT_LOCAL_OLLAMA_PORT);
  const v6 = /^(\[[^\]]+\])(?::(\d+))?$/.exec(rest);
  if (v6) {
    host = v6[1]!;
    if (v6[2]) port = v6[2];
  } else {
    const idx = rest.lastIndexOf(':');
    if (idx >= 0) {
      host = rest.slice(0, idx);
      const p = rest.slice(idx + 1);
      if (!/^\d+$/.test(p)) return fallback;
      port = p;
    }
    if (host === '') host = 'localhost';
  }
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return fallback;
  if (!isLoopbackHost(host)) return fallback;
  return `${scheme}://${host}:${portNum}`;
}
