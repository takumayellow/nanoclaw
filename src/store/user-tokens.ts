import fs from 'fs';
import path from 'path';
import { GuildMember, PermissionFlagsBits } from 'discord.js';

import { DATA_DIR } from '../config.js';
import { getAdminUserIds } from '../env.js';
import { logger } from '../logger.js';

const TOKENS_FILE = path.join(DATA_DIR, 'user-tokens.json');

/** In-memory cache of discordUserId → githubToken */
let tokens: Record<string, string> = {};

function load(): void {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load user-tokens.json, starting fresh');
    tokens = {};
  }
}

function save(): void {
  fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

/** Get the GitHub token for a Discord user, or null if not registered. */
export function getToken(userId: string): string | null {
  if (Object.keys(tokens).length === 0) load();
  return tokens[userId] ?? null;
}

/** Store a GitHub token for a Discord user. */
export function setToken(userId: string, token: string): void {
  if (Object.keys(tokens).length === 0) load();
  tokens[userId] = token;
  save();
  logger.info({ userId }, 'GitHub token registered');
}

/**
 * Determine whether a Discord user should be treated as an admin.
 *
 * An admin bypasses per-user GH_TOKEN injection and uses the top-level token.
 *
 * A user is admin if:
 *  1. Their Discord User ID is listed in ADMIN_USER_IDS (.env), OR
 *  2. The supplied GuildMember has the Discord Administrator permission.
 */
export function isAdmin(userId: string, member?: GuildMember | null): boolean {
  const adminIds = getAdminUserIds();
  if (adminIds.has(userId)) {
    return true;
  }

  if (member) {
    try {
      if (member.permissions.has(PermissionFlagsBits.Administrator)) {
        return true;
      }
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to check member permissions');
    }
  }

  return false;
}
