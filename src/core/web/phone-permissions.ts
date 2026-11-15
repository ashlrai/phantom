/**
 * Read/write decision for one phone route. A read scope cannot write.
 * Denied routes stay denied even for an act device.
 */
import { classifyRemoteRoute } from './remote-gateway-policy.js';

export function phoneRoutePermission(
  scope: { read: boolean; act: boolean },
  method: string,
  path: string,
): 'allow' | 'deny' {
  const route = classifyRemoteRoute(method, path);
  if (route.kind === 'deny') return 'deny';
  if (route.kind === 'write') return scope.act ? 'allow' : 'deny';
  return scope.read ? 'allow' : 'deny';
}
