/** Shared loopback HTTP security, listener, and static-asset helpers for scoped consoles. */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { serveStatic } from './static.js';

const SCOPED_CONSOLE_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'";

export function applyScopedConsoleSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', SCOPED_CONSOLE_CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

export function isLoopbackPortHost(host: string, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export async function listenLoopbackServer(
  server: Server,
  requestedPort: number,
  unavailableMessage: string,
): Promise<{ port: number; origin: string }> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { server.removeListener('listening', listening); reject(error); };
    const listening = (): void => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', listening);
    server.listen(requestedPort, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error(unavailableMessage);
  return { port: address.port, origin: `http://127.0.0.1:${address.port}` };
}

export function serveScopedConsoleAsset(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  mountPath: string,
  assetsDir: string,
): boolean {
  if (pathname !== mountPath && !pathname.startsWith('/next/assets/')) return false;
  const staticRequest = Object.create(req) as IncomingMessage;
  staticRequest.url = pathname === mountPath ? '/next/index.html' : pathname;
  return serveStatic(staticRequest, res, assetsDir);
}
