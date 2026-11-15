/**
 * Optional mirror of a forum channel onto Telegram or Discord.
 * Telegram reuses the existing send path. Discord is a webhook from the
 * environment. Neither adapter reads the post as a command.
 */
import { loadConfig } from '../../config.js';
import { sendTelegramMessage } from '../../integrations/telegram.js';
import { scrubSecrets } from '../../util/scrub.js';
import type { ForumPost } from './types.js';

const DISCORD = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/[0-9]+\/[\w-]{8,}$/;

export function mirrorText(channelTitle: string, post: Pick<ForumPost, 'authorId' | 'kind' | 'body'>): string {
  const line = `${channelTitle} · ${post.authorId} · ${post.kind}\n${post.body}`;
  const scrubbed = scrubSecrets(line);
  return scrubbed.length <= 1500 ? scrubbed : `${scrubbed.slice(0, 1499)}…`;
}

export async function deliverMirror(adapter: 'telegram' | 'discord', text: string, env: NodeJS.ProcessEnv): Promise<'sent' | 'skipped' | 'failed'> {
  if (adapter === 'discord') {
    const url = env.PHANTOM_FORUM_DISCORD_WEBHOOK ?? '';
    if (!DISCORD.test(url)) return 'skipped';
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(2000),
      });
      return response.ok ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  }
  try {
    const result = await sendTelegramMessage(text, undefined, loadConfig());
    return result.ok ? 'sent' : 'skipped';
  } catch {
    return 'skipped';
  }
}
