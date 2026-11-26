import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realHome } from '../real-home.js';
import { fsyncDirectory } from '../util/durability.js';

export const DESKTOP_UPDATE_INTERLOCK = 'DESKTOP_UPDATE_STOP';
const identifier = /^[0-9a-f]{32}$/;
const digest = /^[0-9a-f]{64}$/;

export interface DesktopUpdateInterlock {
  stage: string;
  manifest: string;
  nonce: string;
  deadline: number;
}

export const desktopUpdateInterlockPath = (home: string): string => join(home, '.ashlr', DESKTOP_UPDATE_INTERLOCK);

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function desktopUpdateInterlockPresent(home = realHome()): boolean {
  if (!home) return true;
  try {
    lstatSync(desktopUpdateInterlockPath(home));
    return true;
  } catch (error) {
    return !missing(error);
  }
}

function encode(value: DesktopUpdateInterlock): string {
  return JSON.stringify({stage: value.stage, manifest: value.manifest, nonce: value.nonce, deadline: value.deadline}) + '\n';
}

export function ownsDesktopUpdateInterlock(home: string, value: DesktopUpdateInterlock): boolean {
  let fd: number | undefined;
  try {
    const path = desktopUpdateInterlockPath(home);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const expected = Buffer.from(encode(value));
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
        stat.size !== expected.length) return false;
    const data = Buffer.alloc(expected.length);
    if (readSync(fd, data, 0, data.length, 0) !== data.length || !data.equals(expected)) return false;
    const named = lstatSync(path);
    return named.dev === stat.dev && named.ino === stat.ino && named.ctimeMs === stat.ctimeMs && named.mtimeMs === stat.mtimeMs;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function beginDesktopUpdateInterlock(home: string, stage: string, manifest: string, deadline: number): DesktopUpdateInterlock | null {
  if (!identifier.test(stage) || !digest.test(manifest) || !Number.isSafeInteger(deadline)) return null;
  const value = {stage, manifest, nonce: randomBytes(16).toString('hex'), deadline};
  try {
    const path = desktopUpdateInterlockPath(home);
    const root = lstatSync(home);
    const directory = lstatSync(dirname(path));
    const uid = process.getuid?.();
    if (!root.isDirectory() || root.uid !== uid || (root.mode & 0o022) !== 0 ||
        !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) return null;
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, encode(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(path));
    return ownsDesktopUpdateInterlock(home, value) ? Object.freeze(value) : null;
  } catch {
    return null;
  }
}

export function releaseDesktopUpdateInterlock(home: string, value: DesktopUpdateInterlock): boolean {
  try {
    if (!ownsDesktopUpdateInterlock(home, value)) return false;
    const path = desktopUpdateInterlockPath(home);
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    return true;
  } catch {
    return false;
  }
}
