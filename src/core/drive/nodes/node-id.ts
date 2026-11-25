import { hostname } from 'node:os';
import { validId } from './state.js';

/**
 * The node id `phm node join` assumes when --node is omitted: this machine's
 * hostname reduced to the id alphabet — the same transform nodeSampleHostId
 * applies to capacity samples — with a leading run of non-alphanumerics
 * dropped so the result satisfies validId. Null when nothing valid remains;
 * the caller keeps --node required rather than inventing an id.
 */
export function defaultNodeId(host: () => string = hostname): string | null {
  const id = host()
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 100);
  return validId(id) ? id : null;
}
