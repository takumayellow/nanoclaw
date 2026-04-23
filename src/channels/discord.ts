import {
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  Message,
  ThreadChannel,
  TextChannel,
} from 'discord.js';
import {
  joinVoiceChannel as djsJoinVoiceChannel,
  getVoiceConnection,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  getUserToken,
  setUserToken,
  hasUserToken,
  writeGroupGhToken,
  looksLikeGhToken,
} from '../user-tokens.js';
import { isAdmin } from '../admin-check.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// --- Voice connection state (exported for use by other modules, e.g. STT/TTS) ---

/** Current voice connection, if any. */
export let voiceConnection: VoiceConnection | null = null;

/** Guild ID of the current voice connection */
export let voiceGuildId: string | null = null;

/** Channel ID of the current voice connection */
export let voiceChannelId: string | null = null;

/**
 * Join the voice channel that the given guild member is currently in.
 * Returns the VoiceConnection on success, or null if the member is not in a VC.
 */
export async function joinVC(
  member: GuildMember,
): Promise<VoiceConnection | null> {
  const channel = member.voice.channel;
  if (!channel) {
    return null;
  }

  const connection = djsJoinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    connection.destroy();
    voiceConnection = null;
    voiceGuildId = null;
    voiceChannelId = null;
    logger.error(
      { guildId: channel.guild.id, channelId: channel.id },
      'Voice connection failed to become ready within 15s',
    );
    return null;
  }

  voiceConnection = connection;
  voiceGuildId = channel.guild.id;
  voiceChannelId = channel.id;

  // Clean up state when the connection is destroyed externally
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    voiceConnection = null;
    voiceGuildId = null;
    voiceChannelId = null;
    logger.info('Voice connection destroyed');
  });

  logger.info(
    { guildId: channel.guild.id, channelId: channel.id, channelName: channel.name },
    'Joined voice channel',
  );

  return connection;
}

/**
 * Leave the current voice channel (if connected).
 * Optionally pass a guildId to only leave if we're in that guild.
 */
export function leaveVC(guildId?: string): boolean {
  if (guildId) {
    const connection = getVoiceConnection(guildId);
    if (connection) {
      connection.destroy();
      voiceConnection = null;
      voiceGuildId = null;
      voiceChannelId = null;
      logger.info({ guildId }, 'Left voice channel');
      return true;
    }
    return false;
  }

  if (voiceConnection) {
    voiceConnection.destroy();
    voiceConnection = null;
    voiceGuildId = null;
    voiceChannelId = null;
    logger.info('Left voice channel');
    return true;
  }
  return false;
}

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      // === DM handler: per-user GH token registration ===
      if (!message.guild) {
        const rawContent = message.content.trim();
        if (looksLikeGhToken(rawContent)) {
          setUserToken(message.author.id, rawContent);
          try {
            await message.reply(
              '✅ GitHub トークン登録しました。以降、あなたが作成したスレッドではこのトークンで push されます。',
            );
          } catch (err) {
            logger.warn({ err }, 'Failed to reply in DM after token registration');
          }
          return;
        }
        if (/^(help|ヘルプ|\?)$/i.test(rawContent)) {
          try {
            await message.reply(
              'GitHub Personal Access Token (ghp_... か github_pat_...) を送信してください。\n作成: https://github.com/settings/tokens\n必要な権限: repo (push 権限)',
            );
          } catch (err) {
            logger.warn({ err }, 'Failed to reply help in DM');
          }
          return;
        }
        if (/^(status|登録状況)$/i.test(rawContent)) {
          const has = hasUserToken(message.author.id);
          try {
            await message.reply(
              has
                ? '✅ トークン登録済みです。'
                : '❌ まだトークン登録されていません。`ghp_...` を送信してください。',
            );
          } catch (err) {
            logger.warn({ err }, 'Failed to reply status in DM');
          }
          return;
        }
        // Other DM content — ignore silently (non-trigger for bot)
        return;
      }
      // === end DM handler ===


      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // --- Voice channel commands: /join-vc, /leave-vc ---
      if (message.guild && content.match(/^\/(join-vc|leave-vc)\b/i)) {
        const cmd = content.match(/^\/(join-vc|leave-vc)\b/i)![1].toLowerCase();

        if (cmd === 'join-vc') {
          const member = message.member;
          if (!member?.voice.channel) {
            try {
              await message.reply(
                'You need to be in a voice channel first.',
              );
            } catch {
              /* ignore reply errors */
            }
            return;
          }
          const conn = await joinVC(member);
          if (conn) {
            try {
              await message.reply(
                `Joined **${member.voice.channel.name}**.`,
              );
            } catch {
              /* ignore reply errors */
            }
          } else {
            try {
              await message.reply(
                'Failed to join the voice channel. Please try again.',
              );
            } catch {
              /* ignore reply errors */
            }
          }
          return;
        }

        if (cmd === 'leave-vc') {
          const left = leaveVC(message.guild.id);
          try {
            await message.reply(
              left ? 'Left the voice channel.' : 'I am not in a voice channel.',
            );
          } catch {
            /* ignore reply errors */
          }
          return;
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Auto-register threads under registered parent channels
      // so bot responds in threads inheriting parent's trigger/group settings.
      let group = this.opts.registeredGroups()[chatJid];
      logger.info(
        {
          chatJid,
          chatName,
          channelType: message.channel?.type,
          isThread: typeof (message.channel as any)?.isThread === 'function' ? (message.channel as any).isThread() : 'no-method',
          parentId: (message.channel as any)?.parentId ?? (message.channel as any)?.parent?.id,
          hasRegisterGroup: !!this.opts.registerGroup,
          groupFound: !!group,
        },
        'DEBUG: incoming Discord message inspection',
      );
      if (!group && message.channel.isThread?.()) {
        const threadCh = message.channel as ThreadChannel;
        const parentId = threadCh.parent?.id;
        const parentJid = parentId ? `dc:${parentId}` : undefined;
        const parentGroup = parentJid
          ? this.opts.registeredGroups()[parentJid]
          : undefined;
        if (parentGroup && this.opts.registerGroup) {
          const safeName = (chatName || channelId).replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 60);
          const folder = `${parentGroup.folder}_thread_${channelId}`;
          this.opts.registerGroup(chatJid, {
            name: chatName,
            folder,
            trigger: parentGroup.trigger,
            added_at: new Date().toISOString(),
            containerConfig: parentGroup.containerConfig,
            requiresTrigger: parentGroup.requiresTrigger,
            isMain: parentGroup.isMain,
          });
          logger.info(
            { chatJid, chatName, parentFolder: parentGroup.folder, folder },
            'Auto-registered Discord thread under parent group',
          );
          group = this.opts.registeredGroups()[chatJid];

          // === Per-thread GH token routing ===
          // Determine thread creator. For private/public threads, ownerId is the creator.
          const threadOwnerId =
            (threadCh as any).ownerId || message.author.id;
          try {
            if (!isAdmin(threadOwnerId, message.member)) {
              const userToken = getUserToken(threadOwnerId);
              if (userToken) {
                const groupDir = resolveGroupFolderPath(folder);
                writeGroupGhToken(groupDir, userToken);
                logger.info(
                  { threadOwnerId, folder },
                  'Wrote per-user GH_TOKEN to thread group .env',
                );
              } else {
                // DM the creator asking for a token (best-effort; private threads may block DMs)
                try {
                  const owner = await this.client!.users.fetch(threadOwnerId);
                  await owner.send(
                    `あなたが作成したスレッド「${chatName}」で bot を使うには、GitHub Personal Access Token を DM で送ってください。\n` +
                      '作成: https://github.com/settings/tokens\n' +
                      '必要な権限: repo (push)\n' +
                      '登録後は自動でそのスレッドに反映されます。',
                  );
                  logger.info(
                    { threadOwnerId, chatName },
                    'Sent DM requesting GH token',
                  );
                } catch (err) {
                  logger.warn(
                    { err, threadOwnerId },
                    'Failed to DM thread owner for token',
                  );
                }
              }
            }
          } catch (err) {
            logger.warn({ err }, 'Per-thread GH token routing failed');
          }
          // === end per-thread GH token routing ===
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      for (const t of this.typingIntervals.values()) clearInterval(t);
      this.typingIntervals.clear();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  private typingIntervals: Map<string, NodeJS.Timeout> = new Map();

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    const channelId = jid.replace(/^dc:/, '');

    // Clear any existing refresh interval for this channel
    const existing = this.typingIntervals.get(channelId);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(channelId);
    }
    if (!isTyping) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('sendTyping' in channel)) return;
      await (channel as TextChannel).sendTyping();
      // Discord typing lasts ~10s; refresh every 8s until setTyping(false)
      const interval = setInterval(async () => {
        try {
          await (channel as TextChannel).sendTyping();
        } catch (err) {
          logger.debug({ channelId, err }, 'typing refresh failed');
        }
      }, 8000);
      this.typingIntervals.set(channelId, interval);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
