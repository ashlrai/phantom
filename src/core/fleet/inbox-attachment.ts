import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const INBOX_ATTACH_MAX_CHARS = 64_000;

export function inboxAttachmentPath(runsDir: string, id: string): string {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(id) || id === '.' || id === '..') throw new Error('Invalid inbox attachment id');
  return join(runsDir, 'leader', 'inbox-attachments', `${id}.md`);
}

export function summariseForInbox(text: string, limit: number, id: string, originalLength = text.length): string {
  const prefix = text.slice(0, limit);
  const whitespace = prefix.search(/\s+\S*$/);
  const summary = whitespace > 0 ? prefix.slice(0, whitespace) : prefix;
  return `${summary} … [full text: leader/inbox-attachments/${id}.md, ${originalLength} chars]`;
}

export async function writeInboxAttachment(runsDir: string, id: string, text: string): Promise<void> {
  const path = inboxAttachmentPath(runsDir, id);
  await mkdir(join(runsDir, 'leader', 'inbox-attachments'), { recursive: true });
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
}
