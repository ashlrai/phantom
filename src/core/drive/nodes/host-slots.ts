import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { readNativeBootIdentity } from '../../resources/native-boot-identity.js';
import { inspectPrivateDirectory, privateDirectory } from '../../universe/artifacts.js';
import { readStableRegularFile } from '../../util/stable-file-read.js';

/** One numbered file per RAM slot; O_EXCL serializes contenders without a stale-lock timeout. */
export class HostSlots {
  private readonly identity;
  constructor(private readonly directory: string) {
    this.directory = privateDirectory(directory);
    this.identity = lstatSync(this.directory);
  }
  private check(): void {
    inspectPrivateDirectory(this.directory);
    const stat = lstatSync(this.directory);
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) throw new Error('Host slot directory changed');
  }
  private read(slot: number): string {
    this.check();
    const path = join(this.directory, String(slot)), stat = lstatSync(path);
    if ((stat.mode & 0o777) !== 0o600) throw new Error('Unsafe host slot');
    const read = readStableRegularFile(path, { anchorPath: this.directory, maxFileBytes: 36, remainingBytes: 36 });
    if (!read.ok || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(read.text)) throw new Error('Unmeasured host slot');
    return read.text;
  }
  available(budget: number, lease?: HostSlotLease): number {
    this.check();
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > 64) throw new Error('Invalid host budget');
    const names = readdirSync(this.directory);
    if (names.length > 64 || names.some(n => !/^(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(n))) throw new Error('Unknown host slots');
    for (const name of names) this.read(Number(name));
    if (lease && (lease.registry !== this || !lease.valid())) throw new Error('Host slot lease lost');
    return Math.max(0, budget - names.length + (lease ? 1 : 0));
  }
  acquire(budget: number): HostSlotLease | null {
    if (!this.available(budget)) return null;
    for (let slot = 0; slot < budget; slot++) {
      this.check();
      let fd: number;
      try { fd = openSync(join(this.directory, String(slot)), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
      const token = randomUUID();
      // A crash or uncertain write strands a slot until reboot; never steal from a possibly live runner.
      try { this.check(); writeFileSync(fd, token); } finally { closeSync(fd); }
      return new HostSlotLease(this, slot, token);
    }
    return null;
  }
  owns(lease: HostSlotLease): boolean {
    try { return lease.registry === this && this.read(lease.slot) === lease.token; } catch { return false; }
  }
  release(lease: HostSlotLease): void {
    if (!this.owns(lease)) throw new Error('Host slot lease lost');
    unlinkSync(join(this.directory, String(lease.slot)));
  }
}

export class HostSlotLease {
  constructor(readonly registry: HostSlots, readonly slot: number, readonly token: string) {}
  valid(): boolean { return this.registry.owns(this); }
  release(): void { this.registry.release(this); }
}

let local: HostSlots | undefined;
/** OS account home, independent of HOME/ASHLR_HOME; one physical-host registry per boot. */
export function hostSlots(): HostSlots {
  if (local) return local;
  const identity = readNativeBootIdentity();
  if (!identity) throw new Error('Host identity unmeasured');
  const root = privateDirectory(join(userInfo().homedir, '.ashlr-runs', 'node-host-slots'));
  const machine = privateDirectory(join(root, identity.machineDigest));
  return local = new HostSlots(join(machine, identity.bootId));
}
