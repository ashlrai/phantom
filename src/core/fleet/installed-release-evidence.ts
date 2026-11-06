import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validMilestoneTag, type MilestoneEvidence, type MilestoneReader } from './release-live-notice.js';

const execFileAsync = promisify(execFile);
const plist = '/Applications/Phantom.app/Contents/Info.plist';
const maxBuffer = 128 * 1024;
export type InstalledMetadataRunner = () => Promise<string>;

const runPlutil: InstalledMetadataRunner = async () => {
  const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist],
    { timeout: 5000, maxBuffer, encoding: 'utf8' });
  return stdout;
};

/** Reads installed bundle metadata only; this does not verify a running version or signature. */
export function createInstalledReleaseReader(options: {
  platform?: NodeJS.Platform; run?: InstalledMetadataRunner; now?: () => Date;
} = {}): MilestoneReader {
  return async (repo): Promise<MilestoneEvidence | null> => {
    if ((options.platform ?? process.platform) !== 'darwin' || repo.toLowerCase() !== 'ashlrai/phantom') return null;
    try {
      const stdout = await (options.run ?? runPlutil)();
      const observedAt = (options.now ?? (() => new Date()))().toISOString();
      if (Buffer.byteLength(stdout, 'utf8') > maxBuffer) return null;
      const value: unknown = JSON.parse(stdout);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const row = value as Record<string, unknown>;
      if (row.CFBundleIdentifier !== 'ai.ashlr.desktop' || typeof row.CFBundleShortVersionString !== 'string'
        || row.CFBundleShortVersionString.startsWith('v') || !validMilestoneTag(row.CFBundleShortVersionString)) return null;
      return { repo: 'ashlrai/phantom', version: row.CFBundleShortVersionString, observedAt };
    } catch { return null; }
  };
}
