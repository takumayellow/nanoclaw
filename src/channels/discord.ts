import fs from 'fs';
import path from 'path';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  Message,
  TextChannel,
  ThreadChannel,
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
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { getToken, setToken, isAdmin } from '../store/user-tokens.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** Pattern matching GitHub personal access tokens */
const GH_TOKEN_PATTERN = /^(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)$/;

// --- Voice connection state (exported for use by other modules, e.g. STT/TTS) ---

/** Current voice connection, if any. Other modules can import this to check VC state. */
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

      // --- DM: GitHub token registration ---
      if (message.channel.type === ChannelType.DM) {
        const content = message.content.trim();
        if (GH_TOKEN_PATTERN.test(content)) {
          setToken(message.author.id, content);
          try {
            await message.reply('GitHubトークンを登録しました！');
          } catch (err) {
            logger.warn(
              { userId: message.author.id, err },
              'Failed to reply to DM with token confirmation',
            );
          }
          return;
        }
        // Other DMs fall through to normal processing (e.g. registered solo chats)
      }

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
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // --- Per-user GH_TOKEN injection for threads ---
      // When a message arrives in a Discord thread, inject the thread
      // creator's GitHub token into the group folder's .env so the
      // container picks it up via the per-group GH_TOKEN mechanism.
      if (message.channel.isThread()) {
        const thread = message.channel as ThreadChannel;
        const threadOwnerId = thread.ownerId;
        if (threadOwnerId && !isAdmin(threadOwnerId, message.member)) {
          const userToken = getToken(threadOwnerId);
          if (userToken) {
            try {
              const groupDir = resolveGroupFolderPath(group.folder);
              const envPath = path.join(groupDir, '.env');
              fs.mkdirSync(groupDir, { recursive: true });
              fs.writeFileSync(envPath, `GH_TOKEN=${userToken}\n`);
              logger.info(
                { chatJid, userId: threadOwnerId, folder: group.folder },
                'Injected per-user GH_TOKEN for thread',
              );
            } catch (err) {
              logger.error(
                { chatJid, userId: threadOwnerId, err },
                'Failed to inject per-user GH_TOKEN for thread',
              );
            }
          } else {
            // Thread creator has no token registered — send DM guidance
            try {
              const owner = await this.client!.users.fetch(threadOwnerId);
              await owner.send(
                'GitHubトークンが未登録です。このDMにGitHubトークン（`ghp_...` または `github_pat_...`）を送ってください。',
              );
              logger.info(
                { userId: threadOwnerId },
                'Sent GitHub token registration DM to thread owner',
              );
            } catch (err) {
              logger.warn(
                { userId: threadOwnerId, err },
                'Could not send token registration DM to thread owner',
              );
            }
          }
        }
        // Admin thread owners: no injection needed, top-level GH_TOKEN is used
      }

      // --- Unregistered user (non-thread): DM guidance to register GitHub token ---
      if (
        !message.channel.isThread() &&
        message.guild &&
        !getToken(sender) &&
        !isAdmin(sender, message.member)
      ) {
        try {
          await message.author.send(
            'GitHubトークンが未登録です。このDMにGitHubトークン（`ghp_...` または `github_pat_...`）を送ってください。',
          );
          logger.info({ userId: sender }, 'Sent GitHub token registration DM');
        } catch (err) {
          logger.warn(
            { userId: sender, err },
            'Could not send token registration DM',
          );
        }
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
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
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
