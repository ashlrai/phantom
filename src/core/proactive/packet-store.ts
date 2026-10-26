/** Local prepared briefs, never a connection, sharing grant or provider admission. */
import { join } from 'node:path';
import { readImmutablePrivateRecordPoint, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { companionCanonical } from './coordination-types.js';
import { companionPacketDigest, parseScopedCompanionPacket } from './packets.js';
import type { CompanionPacketV1 } from './packet-types.js';

const codec: ImmutablePrivateRecordCodec<CompanionPacketV1> = {
  parse: parseScopedCompanionPacket,
  serialize: packet => `${companionCanonical(packet)}\n`,
  recordId: packet => `cp_${companionPacketDigest(packet)}`,
  recordFileName: packet => `cp_${companionPacketDigest(packet)}.json`,
  isRecordFileName: name => /^cp_[a-f0-9]{64}\.json$/.test(name),
  stageToken: companionPacketDigest,
  equivalent: (a, b) => companionPacketDigest(a) === companionPacketDigest(b),
};
function config(root: string): ImmutablePrivateRecordStoreConfig<CompanionPacketV1> {
  return { label: 'Prepared companion briefs', anchorPath: root, rootPath: join(root, 'companion-packets'),
    lockFileName: '.packets.lock', maxRecordBytes: 128 * 1024,
    defaultMaxFiles: 2048, hardMaxFiles: 2048, defaultMaxBytes: 64 * 1024 * 1024, hardMaxBytes: 64 * 1024 * 1024,
    codecForRead: () => codec, codecForWrite: () => codec };
}
export function savePreparedCompanionPacket(root: string, packet: CompanionPacketV1, stillAuthorized: () => boolean) {
  return writeImmutablePrivateRecord(config(root), packet, { prepublish: stillAuthorized });
}
export function readPreparedCompanionPacket(root: string, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  const read = readImmutablePrivateRecordPoint(config(root), `cp_${digest}`, `cp_${digest}.json`);
  return read.sourceState === 'healthy' && read.exactReadComplete ? read.record : null;
}
