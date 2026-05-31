/**
 * One-shot script to register /wake, /sleep, /status slash commands with
 * the Discord application.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... node register-commands.js
 *
 * Optional: DISCORD_GUILD_ID for instant per-guild registration during dev.
 * Without it the commands register globally (up to 1 hour propagation).
 */
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !APP_ID) {
  console.error('DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required');
  process.exit(1);
}

const commands = [
  { name: 'wake', description: 'nanoclaw VM を起動する (admin only)' },
  { name: 'sleep', description: 'nanoclaw VM を停止する (admin only)' },
  { name: 'status', description: 'nanoclaw VM の現在状態を確認する' },
];

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

const res = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error('Registration failed:', res.status, await res.text());
  process.exit(1);
}
console.log(`Registered ${commands.length} commands ${GUILD_ID ? `to guild ${GUILD_ID}` : 'globally'}.`);
