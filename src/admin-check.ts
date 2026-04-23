/**
 * Admin detection for per-user token flow.
 * A user is admin if:
 *   - Their Discord user ID is in .env ADMIN_USER_IDS (comma-separated)
 *   - OR they have Discord Administrator permission in the guild
 *
 * Admins bypass the DM-token flow and use the top-level .env GH_TOKEN.
 */
import { PermissionFlagsBits, GuildMember } from 'discord.js';
import { readEnvFile } from './env.js';

function getAdminIds(): Set<string> {
  const env = readEnvFile(['ADMIN_USER_IDS']);
  const raw = env.ADMIN_USER_IDS || process.env.ADMIN_USER_IDS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isAdmin(userId: string, member?: GuildMember | null): boolean {
  const adminIds = getAdminIds();
  if (adminIds.has(userId)) return true;
  if (member?.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return false;
}
