/** Bounded public HTTPS GET. No cookies, auth, proxy configuration or redirects. */
import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { BlockList } from 'node:net';
import { radarSourceSchema, type RadarSource } from './sources.js';

export const RADAR_MAX_BYTES = 2 * 1024 * 1024;
export const RADAR_TIMEOUT_MS = 15_000;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4');

export async function fetchRadarSource(input: RadarSource): Promise<string> {
  const source = radarSourceSchema.parse(input);
  if (!source.verified) throw new Error('Radar source is not verified');
  // One deadline includes DNS, TLS, headers and the entire body. Pin the checked
  // IPv4 answer in lookup so a second DNS answer cannot redirect to local state.
  let expired = false;
  let cancel: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async (): Promise<string> => {
    const addresses = await lookup(new URL(source.url).hostname, { all: true, family: 4 });
    if (expired) throw new Error();
    if (!addresses.length || addresses.some(({ address }) => blocked.check(address, 'ipv4'))) throw new Error();
    return new Promise((resolve, reject) => {
      const request = get(source.url, {
        method: 'GET', agent: false,
        headers: { accept: '*/*', 'accept-encoding': 'identity' },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, 4);
        },
      }, response => {
        if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy(); request.destroy(); reject(new Error()); return;
        }
        const length = response.headers['content-length'];
        if (length && (!/^\d+$/.test(length) || Number(length) > RADAR_MAX_BYTES)) {
          response.destroy(); request.destroy(); reject(new Error()); return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > RADAR_MAX_BYTES) { response.destroy(); request.destroy(); reject(new Error()); }
          else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
        response.on('aborted', () => reject(new Error()));
      });
      cancel = () => request.destroy();
      request.on('error', reject);
    });
  };
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { expired = true; cancel?.(); reject(new Error()); }, RADAR_TIMEOUT_MS);
      }),
    ]);
  } catch { throw new Error('Radar public source unavailable'); }
  finally { clearTimeout(timer); }
}
