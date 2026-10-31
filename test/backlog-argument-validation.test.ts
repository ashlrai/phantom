import { describe, expect, it, vi } from 'vitest';
import { cmdBacklog } from '../src/cli/backlog.js';

describe('backlog argument validation', () => {
  it.each([
    [['list', 'refresh'], 'Specify only one backlog subcommand'],
    [['refresh', 'list'], 'Specify only one backlog subcommand'],
    [['refresh', 'refresh'], 'Specify only one backlog subcommand'],
    [['--repo', '--json'], '--repo requires a path argument'],
    [['--limit', '2oops'], '--limit requires a positive integer'],
    [['--limit', '1.5'], '--limit requires a positive integer'],
    [['--limit', '9007199254740992'], '--limit requires a positive integer'],
  ])('rejects %j before executing', async (args, message) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdBacklog(args)).toBe(2);
      expect(error.mock.calls.flat().join(' ')).toContain(message);
    } finally {
      error.mockRestore();
    }
  });
});
