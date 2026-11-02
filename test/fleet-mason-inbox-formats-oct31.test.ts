import { describe, expect, it } from 'vitest';
import { formatInboxEntry, parseInbox } from '../src/core/fleet/mason-inbox.js';

describe('Inbox format round-trip (oct31-format-swap)', () => {
  it('case 1: desktop heading parses to expected at/source/priority', () => {
    const heading = '## 2026-10-31 00:52 ET (Mason, Phantom desktop) PRIORITY P0';
    const body = 'A quick note from the desktop.';
    const markdown = heading + '\n' + body + '\n';
    const entries = parseInbox(markdown);
    expect(entries).toHaveLength(1);
    expect(entries[0].at).toBe('2026-10-31 00:52');
    expect(entries[0].source).toBe('Phantom desktop');
    expect(entries[0].priority).toBe('P0');
    expect(entries[0].text).toBe('A quick note from the desktop.');
  });

  it('case 2: page heading (relayed by Masbot)', () => {
    const heading = '## 2026-10-31 00:10 ET (Mason, relayed by Masbot) PRIORITY P0';
    const markdown = heading + '\npage note\n';
    const entries = parseInbox(markdown);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('relayed by Masbot');
    expect(entries[0].priority).toBe('P0');
    expect(entries[0].at).toBe('2026-10-31 00:10');
  });

  it('case 3: terminal heading parses source as terminal', () => {
    const heading = '## 2026-10-30 23:59 ET (Mason, terminal) PRIORITY P0';
    const markdown = heading + '\nfrom terminal\n';
    const entries = parseInbox(markdown);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('terminal');
  });

  it('case 4: heading with bracketed suffix still yields priority and source', () => {
    // Trailing words after PRIORITY must not break parsing
    const heading = '## 2026-10-31 00:36 ET (Mason, relayed by Masbot) PRIORITY P0 NORTH STAR (restated)';
    const markdown = heading + '\nbody text\n';
    const entries = parseInbox(markdown);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('relayed by Masbot');
    expect(entries[0].priority).toBe('P0');
  });

  it('case 5: multi-paragraph body respects ## delimiter', () => {
    const md = [
      '## 2026-10-31 01:00 ET (Mason, Phantom desktop) PRIORITY P1',
      'line one',
      '',
      '- bullet item',
      '## 2026-10-31 02:00 ET (Mason, Telegram) PRIORITY P0',
      'second entry body',
    ].join('\n');
    const entries = parseInbox(md);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe('second entry body');
    // First entry ends at the next ## line
    const first = entries[1];
    expect(first.source).toBe('Phantom desktop');
    expect(first.priority).toBe('P1');
    const textLines = first.text.split('\n');
    expect(textLines).toContain('line one');
    expect(textLines).toContain('- bullet item');
  });

  it('case 6: CRLF input parses identically to LF', () => {
    const lfHeading = '## 2026-10-31 03:00 ET (Mason, Phantom desktop) PRIORITY P0';
    const crlfHeading = lfHeading.replace('\n', '\r\n');
    const lfMd = lfHeading + '\nlf body\n';
    const crlfMd = crlfHeading + '\r\ncrlf body\r\n';
    const lfEntries = parseInbox(lfMd);
    const crlfEntries = parseInbox(crlfMd);
    expect(crlfEntries[0].at).toBe(lfEntries[0].at);
    expect(crlfEntries[0].source).toBe(lfEntries[0].source);
    expect(crlfEntries[0].text).toBe('crlf body');
  });

  it('case 7: round trip parseInbox(formatInboxEntry(text)) preserves text', () => {
    const text = 'Hello\nsecond line\n\nmore lines';
    const date = new Date('2026-10-31T05:30:00Z');
    const formatted = formatInboxEntry(text, 'Phantom desktop', date);
    const parsed = parseInbox(formatted);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe(text.trim());
  });

  it('case 8: limit 2 over 5 entries returns newest 2, newest first', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      const date = `2026-10-31 0${i}:00`;
      lines.push(
        `## ${date} ET (Mason, Phantom desktop) PRIORITY P0`,
        `entry ${i}`,
      );
    }
    const md = lines.join('\n');
    const entries = parseInbox(md, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0].at).toBe('2026-10-31 04:00');
    expect(entries[1].at).toBe('2026-10-31 03:00');
  });
});
