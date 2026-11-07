import { expect, it } from 'vitest';
import { sourceChip } from './interject-ack-model.js';

it('labels every inbound channel and supported source, ignoring case', () => {
  const cases: Array<[string, string]> = [
    ['desktop', 'Phantom desktop'], ['phantom desktop', 'Phantom desktop'],
    ['phantom desktop chat', 'Chat'], ['chat', 'Chat'], ['phone', 'Phone'],
    ['mobile', 'Mobile remote'], ['phantom mobile', 'Mobile remote'], ['mobile remote', 'Mobile remote'],
    ['telegram', 'Telegram'], ['telegram bot', 'Telegram'], ['email', 'Email'], ['webmail', 'Email'],
    ['terminal', 'Terminal'], ['cli', 'Terminal'], ['page', 'Page'], ['fleet-say', 'fleet-say'],
    ['mcp', 'MCP'], ['api', 'API'],
  ];
  for (const [source, label] of cases) expect(sourceChip(`  ${source.toUpperCase()}  `)).toBe(label);
});

it('trims and caps unknown sources at 24 characters', () => {
  expect(sourceChip('  custom source  ')).toBe('custom source');
  expect(sourceChip('  12345678901234567890123456789  ')).toBe('123456789012345678901234');
});
