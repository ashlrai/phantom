#!/usr/bin/env -S npx tsx
/** Post one data-only task to the local bus and read its receipt back. */
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBusEnvelope } from '../../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions } from '../../src/core/fleet/bus-inbox.js';

interface Dependencies {
  options?: BusInboxOptions;
  write?: (line: string) => void;
}

/** Returns the process exit code; options and output are injectable for local callers. */
export function runBusTaskRoundtrip(args: string[], deps: Dependencies = {}): number {
  const write = deps.write ?? ((line: string) => console.log(line));
  const output = (value: unknown, code: number): number => {
    write(JSON.stringify(value));
    return code;
  };
  const values: Record<string, string> = {};
  let mode: 'dry-run' | 'post' | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '--post') {
      if (mode) return output({ status: 'invalid-arguments' }, 2);
      mode = arg.slice(2) as 'dry-run' | 'post';
    } else if (['--from', '--to', '--id', '--text', '--root'].includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--') || Object.hasOwn(values, arg)) {
        return output({ status: 'invalid-arguments' }, 2);
      }
      values[arg] = value;
    } else return output({ status: 'invalid-arguments' }, 2);
  }
  if (!mode || ['--from', '--to', '--id', '--text'].some(key => !Object.hasOwn(values, key)) ||
      (values['--root'] !== undefined && !isAbsolute(values['--root']))) {
    return output({ status: 'invalid-arguments' }, 2);
  }
  const checked = validateBusEnvelope({
    id: values['--id'], from: values['--from'], to: values['--to'],
    priority: 'P2', ttl: 60_000, body: { text: values['--text'] },
  });
  if (!checked.ok) return output({ status: 'invalid-envelope', issues: checked.issues }, 2);
  if (mode === 'dry-run') return output(checked.value, 0);

  const options = { ...deps.options, ...(values['--root'] === undefined ? {} : { root: values['--root'] }) };
  const post = appendBusInbox(checked.value, options);
  if (post.status !== 'posted' && post.status !== 'duplicate') return output(post, 3);
  // Limit the global log to this receipt, without exposing unrelated messages.
  const page = listBusInboxAfter(post.cursor - 1, 1, options);
  if (page.status !== 'ok') return output({ status: 'read-failed', post, reason: page.status }, 4);
  const receipt = page.messages[0];
  if (!receipt || receipt.cursor !== post.cursor || receipt.envelope.id !== post.id) {
    return output({ status: 'read-failed', post, reason: 'receipt-unavailable' }, 4);
  }
  return output({ status: post.status, receipt, nextCursor: page.nextCursor }, 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runBusTaskRoundtrip(process.argv.slice(2));
}
