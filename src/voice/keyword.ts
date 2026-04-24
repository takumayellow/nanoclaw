import { TextChannel, NewsChannel, ThreadChannel } from 'discord.js';

import { logger } from '../logger.js';

const DECISION_KEYWORDS = [
  '確定',
  'これで行こう',
  'これで進めよう',
  'これでいこう',
];

/**
 * Check whether the given text contains a "decision" keyword.
 */
export function checkKeyword(text: string): boolean {
  return DECISION_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * Create a decision thread in the given channel and post the summary
 * as the first message.
 */
export async function createDecisionThread(
  channel: TextChannel | NewsChannel,
  summary: string,
): Promise<ThreadChannel> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const threadName = `方針確定-${timestamp}`;

  const thread = await channel.threads.create({
    name: threadName,
    reason: 'Decision keyword detected in voice chat',
  });

  await thread.send(summary);

  logger.info(
    { threadId: thread.id, threadName },
    'Created decision thread from keyword detection',
  );

  return thread;
}
