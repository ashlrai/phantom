import { isDeepStrictEqual } from 'node:util';

/** Experimental, read-only Phantom peer discovery protocol, version 1. */
export const PHANTOM_DISCOVERY_PATH = '/api/phantom/discovery';
export const PHANTOM_PING_PATH = '/api/phantom/ping';

export const phantomManifest = {
  protocol: 'phantom-api-discovery',
  version: 1,
  operations: [{ name: 'ping', method: 'GET', path: PHANTOM_PING_PATH, response: { ok: 'boolean' } }],
} as const;

/** Generate TypeScript only for the protocol and operations we understand.
 * Rejecting unknown contracts avoids turning peer-controlled strings into code. */
export function generatePhantomClient(manifest: unknown): string {
  if (!isDeepStrictEqual(manifest, phantomManifest)) {
    throw new Error('Unsupported Phantom discovery manifest');
  }
  return `// Generated from Phantom discovery protocol v1.\nexport interface PingResponse { ok: boolean }\nexport class PhantomClient {\n  constructor(private readonly baseUrl: string, private readonly readToken: string) {}\n  async ping(): Promise<PingResponse> {\n    const response = await fetch(new URL('${PHANTOM_PING_PATH}', this.baseUrl), {\n      headers: { 'x-ashlr-token': this.readToken }, redirect: 'error'\n    });\n    if (!response.ok) throw new Error(\`Phantom ping failed: \${response.status}\`);\n    const value: unknown = await response.json();\n    if (!value || typeof value !== 'object' || typeof (value as PingResponse).ok !== 'boolean')\n      throw new Error('Invalid Phantom ping response');\n    return value as PingResponse;\n  }\n}\n`;
}
